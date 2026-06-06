import wixData from 'wix-data';
import { resolveCoordsFromShortLinks } from 'backend/resolveMapLink';

let cachedCountries = null;
let cachedTemples = null;
let isDataLoaded = false;
let isIframeReady = false;
let hasSentData = false;

const MAP_COMPONENT_ID = "#htmlMap";

$w.onReady(function () {
    loadCmsData();

    $w(MAP_COMPONENT_ID).onMessage((event) => {
        if (event.data && event.data.type === "READY") {
            console.log("Map HTML Component is ready to receive data.");
            isIframeReady = true;
            sendDataToMap();
        }
    });
});

const INDIA_FALLBACK = { coords: /** @type {[number, number]} */ ([28.6139, 77.2090]), zoom: 5 };

/**
 * Disambiguate lat/lng when both values fall in valid ranges.
 * Fixes US coords where longitude (e.g. -88) was stored in the latitude field.
 * @param {number} a
 * @param {number} b
 * @returns {[number, number] | null}
 */
function normalizeLatLngPair(a, b) {
    if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [b, a];
    if (Math.abs(b) > 90 && Math.abs(a) <= 90) return [a, b];
    if (a < -30 && b >= -30 && b <= 90) return [b, a];
    if (b < -30 && a >= -30 && a <= 90) return [a, b];
    if (Math.abs(a) > 60 && Math.abs(b) < 60) return [b, a];
    if (Math.abs(b) > 60 && Math.abs(a) < 60) return [a, b];
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a, b];
    return null;
}

/**
 * Gets final coordinates for a CMS item.
 * Priority:
 *   1. templeLocation short URL → resolved lat/lng (via backend)
 *   2. templeLatitude / templeLongitude DB fields
 *   3. Hardcoded India fallback (only for India world marker, last resort)
 * Auto-detects swapped lat/lng by checking value ranges.
 * @param {object} item - CMS record
 * @param {object} urlCoordsMap - map of resolved short URL → { lat, lng }
 * @returns {[number, number] | null}
 */
function getCoordsForItem(item, urlCoordsMap) {
    if (item.templeLocation && urlCoordsMap[item.templeLocation]) {
        const c = urlCoordsMap[item.templeLocation];
        return /** @type {[number, number]} */ ([c.lat, c.lng]);
    }

    const a = parseFloat(item.templeLatitude);
    const b = parseFloat(item.templeLongitude);
    if (!isNaN(a) && !isNaN(b)) {
        const normalized = normalizeLatLngPair(a, b);
        if (normalized) return /** @type {[number, number]} */ (normalized);
    }

    const viewType = (item.viewType || '').toLowerCase().trim();
    const country  = (item.countryName || '').toLowerCase().trim();
    if (viewType === 'world' && country === 'india') {
        console.warn('Using hardcoded fallback coords for India world marker');
        return /** @type {[number, number]} */ ([INDIA_FALLBACK.coords[0], INDIA_FALLBACK.coords[1]]);
    }

    return null;
}

/**
 * Converts a Wix media URI (wix:image://v1/...) to a public https URL.
 * If already a plain URL, returns as-is.
 * @param {string} wixUri
 * @returns {string}
 */
function wixImageToUrl(wixUri) {
    if (!wixUri) return '';

    // wix:image://v1/{fileId}/{displayName}#originWidth=...
    // fileId includes the extension e.g. abc123~mv2.png
    if (wixUri.startsWith('wix:image://v1/')) {
        const withoutPrefix = wixUri.replace('wix:image://v1/', '');
        // fileId is everything up to the first '/'
        const fileId = withoutPrefix.split('/')[0];
        if (fileId) {
            return `https://static.wixstatic.com/media/${fileId}`;
        }
    }

    // Plain https URL — validate it looks like an actual image, not a website homepage
    if (wixUri.startsWith('http')) {
        const lower = wixUri.toLowerCase();
        const hasImageExt = /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?|#|$)/.test(lower);
        // Accept if it has an image extension OR is from a known image CDN
        if (hasImageExt || lower.includes('wixstatic.com') || lower.includes('static.')) {
            return wixUri;
        }
        // Website homepage URLs (no image extension) — not usable as img src
        console.warn(`templeImage looks like a website URL, not an image: ${wixUri}`);
        return '';
    }

    console.warn('Could not convert image URI:', wixUri);
    return '';
}

/**
 * Fetches data from the single "TempleLocationMap" Wix Collection and normalizes it.
 *
 * Performance strategy:
 *  - Items WITHOUT a mapLink get coords instantly from lat/lng — no async needed.
 *  - Items WITH a mapLink are batched into ONE backend call that resolves all
 *    short URLs in parallel with a 3-second per-URL timeout.
 *  - This means the map loads as fast as the slowest short-URL redirect (max 3s),
 *    regardless of how many items there are.
 */
async function loadCmsData() {
    try {
        console.log("Fetching map data from TempleLocationMap CMS collection...");
        const result = await wixData.query("TempleLocationMap")
            .limit(1000)
            .find();

        const items = result.items || [];
        console.log(`Fetched ${items.length} records from Wix CMS.`);

        const linkItems = items.map((item, i) => ({ index: i, url: item.templeLocation || null }));
        const urlsToResolve = linkItems.filter(x => x.url).map(x => x.url);

        // One backend call resolves all short URLs in parallel
        let resolvedCoords = [];
        if (urlsToResolve.length > 0) {
            console.log(`Resolving ${urlsToResolve.length} map links in one batch call...`);
            resolvedCoords = await resolveCoordsFromShortLinks(urlsToResolve);
        }

        // Build a map: templeLocation URL → resolved coords (or null)
        const urlCoordsMap = {};
        let resolvedIndex = 0;
        linkItems.forEach(x => {
            if (x.url) {
                urlCoordsMap[x.url] = resolvedCoords[resolvedIndex++] || null;
            }
        });

        const countryZoomMap = {
            "india": INDIA_FALLBACK.zoom
        };

        const countries = [];
        const temples = [];
        const seenCountries = new Set();

        items.forEach(item => {
            const coords = getCoordsForItem(item, urlCoordsMap);
            if (!coords) {
                console.warn(`Skipping item "${item.templeName || item.countryName || 'unknown'}" — no valid coordinates`);
                return;
            }

            const coordSource = (item.templeLocation && urlCoordsMap[item.templeLocation])
                ? 'url'
                : (!isNaN(parseFloat(item.templeLatitude)) && !isNaN(parseFloat(item.templeLongitude)) ? 'db' : 'fallback');
            const coordDebug = {
                coordSource,
                dbLat: item.templeLatitude,
                dbLng: item.templeLongitude,
                templeLocation: item.templeLocation || null,
                urlResolved: item.templeLocation ? urlCoordsMap[item.templeLocation] : null
            };

            const viewType   = (item.viewType || '').toLowerCase().trim();
            const countryKey = (item.countryName || '').toLowerCase().trim();
            const name       = item.templeName || '';
            const state      = item.regionType || '';
            const country    = item.countryName || '';
            const image      = wixImageToUrl(item.templeImage || '');

            if (viewType === 'world') {
                if (!country) {
                    console.warn(`Skipping World item — missing countryName`);
                    return;
                }
                if (!name) {
                    console.warn(`Skipping World item — missing templeName`);
                    return;
                }

                // Add one country dot per unique country (used for flyTo on India button etc.)
                if (!seenCountries.has(countryKey)) {
                    seenCountries.add(countryKey);
                    const zoom = countryZoomMap[countryKey] || 4;
                    // Use resolved temple coords for the country dot so it matches the pin location
                    countries.push({ name: country, coords, zoom });
                    console.log(`Country added: ${country} at [${coords}]`);
                }

                // Also add as a temple so the popup shows name + image
                const locationUrl = item.templeLocation || '';
                const video = item.templeVideo || '';
                temples.push({ name, state, country, coords, image, isWorld: true, locationUrl, video, coordDebug });
                console.log(`World temple added: ${name} (${country}) at [${coords}] source=${coordSource}`);

            } else {
                // India or other country-specific view
                if (!name) {
                    console.warn(`Skipping temple item — missing templeName (viewType: "${item.viewType}", country: "${country}")`);
                    return;
                }
                const locationUrl = item.templeLocation || '';
                const video = item.templeVideo || '';
                temples.push({ name, state, country, coords, image, isWorld: false, locationUrl, video, coordDebug });
                console.log(`Temple added: ${name} (${country}) at [${coords}]`);
            }
        });

        // Ensure India always appears as a country dot even if not in DB
        if (!seenCountries.has('india')) {
            countries.push({ name: 'India', coords: INDIA_FALLBACK.coords, zoom: INDIA_FALLBACK.zoom });
            console.log('India country marker injected from fallback');
        }

        // Extract unique region names from India temples for the filter dropdown
        const indiaRegions = [...new Set(
            temples
                .filter(t => !t.isWorld && t.country.toLowerCase().trim() === 'india' && t.state)
                .map(t => t.state)
        )];

        cachedCountries = countries;
        cachedTemples = temples;

        console.log(`CMS Data normalized: ${cachedCountries.length} countries, ${cachedTemples.length} temples, ${indiaRegions.length} India regions.`);
        isDataLoaded = true;

        // Try sending data if the iframe is already ready
        sendDataToMap();

    } catch (error) {
        console.error("Failed to load map data from TempleLocationMap collection:", error);
    }
}

/**
 * Sends the loaded data to the HTML component if both data and iframe are ready
 */
function sendDataToMap() {
    if (isDataLoaded && isIframeReady && !hasSentData) {
        // Extract regions from cached temples for the dropdown
        const regions = [...new Set(
            cachedTemples
                .filter(t => !t.isWorld && t.country.toLowerCase().trim() === 'india' && t.state)
                .map(t => t.state)
        )];

        $w(MAP_COMPONENT_ID).postMessage({
            type: "LOAD_DATA",
            countries: cachedCountries,
            temples: cachedTemples,
            regions: regions
        });
        hasSentData = true;
        console.log("Successfully posted CMS data to Map HTML component.");
    }
}
