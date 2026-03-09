const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const FETCH_HEADERS = {
  "user-agent": "jam-stats/1.0",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(message);
}

function sendNoContent(res) {
  res.writeHead(204, {
    "cache-control": "no-store",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end();
}

function normalizeJamInput(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error("enter an itch jam url, slug, or numeric jam id");
  }

  if (/^\d+$/.test(value)) {
    return {
      kind: "id",
      jamId: value,
      slug: null,
      original: value,
    };
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!hostname.endsWith("itch.io")) {
      throw new Error("only itch.io jam urls are supported");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "jam" || !parts[1]) {
      throw new Error("use an itch.io jam url like https://itch.io/jam/brackeys-15");
    }

    const candidate = parts[1];
    if (/^\d+$/.test(candidate)) {
      return {
        kind: "id",
        jamId: candidate,
        slug: null,
        original: value,
      };
    }

    return {
      kind: "slug",
      jamId: null,
      slug: candidate,
      original: value,
    };
  } catch (error) {
    if (error instanceof TypeError) {
      return {
        kind: "slug",
        jamId: null,
        slug: value.replace(/^\/+|\/+$/g, ""),
        original: value,
      };
    }

    throw error;
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`request to ${url} failed with ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`request to ${url} failed with ${response.status}`);
  }

  return response.json();
}

function extractJamIdFromHtml(html) {
  const patterns = [
    /new I\.ViewJam\([^]*?"id":\s*(\d+)/,
    /\/jam\/(\d+)\/entries\.json/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function extractEntriesUrlFromEntriesHtml(html) {
  const patterns = [
    /"entries_url":"([^"]*entries\.json)"/,
    /\/jam\/[^"'\\\s]+\/entries\.json/,
    /\/jam\/\d+\/entries\.json/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return (match[1] || match[0]).replaceAll("\\/", "/");
    }
  }

  return null;
}

async function resolveFeedInfoFromSlug(slug) {
  const entriesPageUrl = `https://itch.io/jam/${encodeURIComponent(slug)}/entries`;
  const entriesHtml = await fetchText(entriesPageUrl);
  const rawEntriesUrl = extractEntriesUrlFromEntriesHtml(entriesHtml);

  if (rawEntriesUrl) {
    const feedUrl = rawEntriesUrl.startsWith("http") ? rawEntriesUrl : `https://itch.io${rawEntriesUrl}`;
    const jamIdMatch = feedUrl.match(/\/jam\/(\d+)\/entries\.json/);
    if (jamIdMatch) {
      return {
        feedUrl,
        jamId: jamIdMatch[1],
        resolvedVia: "entries-page-script",
      };
    }

    const jamHtml = await fetchText(`https://itch.io/jam/${encodeURIComponent(slug)}`);
    const jamId = extractJamIdFromHtml(jamHtml);
    return {
      feedUrl,
      jamId,
      resolvedVia: jamId ? "entries-page-script" : "entries-page-url",
    };
  }

  const jamHtml = await fetchText(`https://itch.io/jam/${encodeURIComponent(slug)}`);
  const jamId = extractJamIdFromHtml(jamHtml);
  if (jamId) {
    return {
      feedUrl: `https://itch.io/jam/${jamId}/entries.json`,
      jamId,
      resolvedVia: "jam-page-source",
    };
  }

  throw new Error(`unable to infer a numeric jam id for "${slug}"`);
}

function inferSlug(explicitSlug, entries) {
  if (explicitSlug) {
    return explicitSlug;
  }

  const firstUrl = entries.find((entry) => typeof entry?.url === "string")?.url;
  if (!firstUrl) {
    return null;
  }

  const match = firstUrl.match(/^\/jam\/([^/]+)\//);
  return match ? match[1] : null;
}

function computeKarma(coolness, ratingCount) {
  return Math.log(1 + coolness) - Math.log(1 + ratingCount) / Math.log(5);
}

function normalizeEntries(entriesPayload, jamId, slug, feedUrl) {
  const jamGames = Array.isArray(entriesPayload?.jam_games) ? entriesPayload.jam_games : [];
  const inferredSlug = inferSlug(slug, jamGames);
  const totalEntries = jamGames.length;

  const rows = jamGames.map((entry, index) => {
      const game = entry?.game || {};
      const owner = game?.user || {};
      const rawContributors = Array.isArray(entry?.contributors) && entry.contributors.length
        ? entry.contributors
        : owner?.name
          ? [{ name: owner.name, url: owner.url || game.url || "" }]
          : [];

      const contributors = rawContributors
        .map((contributor) => ({
          name: String(contributor?.name || "").trim(),
          url: String(contributor?.url || "").trim(),
        }))
        .filter((contributor) => contributor.name);

      const ratingCount = Number(entry?.rating_count) || 0;
      const coolness = Number(entry?.coolness) || 0;
      const popularityRank = index + 1;
      const gameTitle = String(game?.title || "untitled entry").trim() || "untitled entry";
      const platforms = Array.isArray(game?.platforms)
        ? game.platforms.map((platform) => String(platform || "").trim()).filter(Boolean)
        : [];
      const submissionUrl = typeof entry?.url === "string" && entry.url
        ? `https://itch.io${entry.url}`
        : "";
      const projectUrl = String(game?.url || "").trim();
      const karma = computeKarma(coolness, ratingCount);

      return {
        submissionId: Number(entry?.id) || null,
        projectId: Number(game?.id) || null,
        gameName: gameTitle,
        projectUrl,
        submissionUrl,
        contributors,
        contributorsText: contributors.map((contributor) => contributor.name).join(", "),
        popularity: popularityRank,
        popularityRank,
        popularityDisplay: String(popularityRank),
        popularityPercentile: totalEntries > 0 ? round((popularityRank / totalEntries) * 100, 3) : null,
        totalRating: ratingCount,
        ratesGiven: coolness,
        coolness,
        karma: round(karma, 3),
        platforms,
        platformsText: platforms.join(", "),
        coverUrl: String(game?.cover || "").trim(),
        createdAt: String(entry?.created_at || "").trim(),
        owner: owner?.name
          ? {
              name: String(owner.name),
              url: String(owner.url || ""),
            }
          : null,
        searchableText: `${gameTitle} ${contributors.map((contributor) => contributor.name).join(" ")}`.toLowerCase(),
      };
    });

  return {
    jamId,
    jamSlug: inferredSlug,
    feedUrl,
    generatedOn: Number(entriesPayload?.generated_on) || null,
    rows,
    notes: {
      popularity: "popularity uses the native order of jam_games in entries.json which itch returns in popularity order",
      totalRating: "total rating uses the raw rating_count value from entries.json",
      ratesGiven: "following itch-analytics the coolness value exposed by entries.json is used as the available votes-given signal",
      coolness: "coolness comes directly from entries.json",
      karma: "karma is computed client-side as log(1 + coolness) - (log(1 + rating_count) / log(5))",
    },
  };
}

async function handleEntriesRequest(reqUrl, res) {
  const rawInput = reqUrl.searchParams.get("input");

  try {
    const parsedInput = normalizeJamInput(rawInput);
    const resolved = parsedInput.jamId
      ? {
          jamId: parsedInput.jamId,
          feedUrl: `https://itch.io/jam/${parsedInput.jamId}/entries.json`,
          resolvedVia: "direct-id",
        }
      : await resolveFeedInfoFromSlug(parsedInput.slug);

    const jamId = resolved.jamId || null;
    if (!jamId) {
      throw new Error("unable to determine the numeric jam id from the entries feed");
    }

    const feedUrl = resolved.feedUrl;
    const entriesPayload = await fetchJson(feedUrl);
    const normalized = normalizeEntries(entriesPayload, jamId, parsedInput.slug, feedUrl);

    sendJson(res, 200, {
      input: parsedInput.original,
      resolvedVia: resolved.resolvedVia,
      ...normalized,
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "unable to load jam entries",
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendText(res, 400, "bad request");
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "OPTIONS") {
    sendNoContent(res);
    return;
  }

  if (reqUrl.pathname === "/") {
    sendText(res, 200, "jam-stats api");
    return;
  }

  if (req.method !== "GET") {
    sendText(res, 405, "method not allowed");
    return;
  }

  if (reqUrl.pathname === "/api/entries") {
    await handleEntriesRequest(reqUrl, res);
    return;
  }

  sendText(res, 404, "not found");
});

server.listen(PORT, HOST, () => {
  console.log(`jam-stats api running at http://${HOST}:${PORT}`);
});
