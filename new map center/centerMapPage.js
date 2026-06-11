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
 * Approximate centre coords for each region/state name.
 * Used as a last-resort fallback when URL resolution fails and no
 * address.location is stored in the CMS record.
 */
const REGION_FALLBACK_COORDS = {
    'andhra pradesh':  [15.9129,  79.7400],
    'assam':           [26.2006,  92.9376],
    'bihar':           [25.0961,  85.3131],
    'chhattisgarh':    [21.2787,  81.8661],
    'goa':             [15.2993,  74.1240],
    'gujarat':         [22.2587,  71.1924],
    'haryana':         [29.0588,  76.0856],
    'himachal pradesh':[31.1048,  77.1734],
    'jharkhand':       [23.6102,  85.2799],
    'karnataka':       [15.3173,  75.7139],
    'kerala':          [10.8505,  76.2711],
    'madhya pradesh':  [22.9734,  78.6569],
    'maharashtra':     [19.7515,  75.7139],
    'manipur':         [24.6637,  93.9063],
    'meghalaya':       [25.4670,  91.3662],
    'mizoram':         [23.1645,  92.9376],
    'nagaland':        [26.1584,  94.5624],
    'odisha':          [20.9517,  85.0985],
    'punjab':          [31.1471,  75.3412],
    'rajasthan':       [27.0238,  74.2179],
    'sikkim':          [27.5330,  88.5122],
    'tamil nadu':      [11.1271,  78.6569],
    'telangana':       [18.1124,  79.0193],
    'tripura':         [23.9408,  91.9882],
    'uttar pradesh':   [26.8467,  80.9462],
    'uttarakhand':     [30.0668,  79.0193],
    'west bengal':     [22.9868,  87.8550],
    'delhi':           [28.6139,  77.2090],
    'gurugram':        [28.4595,  77.0266],
    'noida':           [28.5355,  77.3910],
    'usa':             [37.0902, -95.7129],
};

/**
 * Gets final coordinates for a CMS item.
 * Priority:
 *   1. url short URL → resolved lat/lng (via backend)
 *   2. address.location DB fields
 *   3. region name → approximate state/city fallback coords
 * @param {object} item - CMS record
 * @param {object} urlCoordsMap - map of resolved short URL → { lat, lng }
 * @returns {[number, number] | null}
 */
function getCoordsForItem(item, urlCoordsMap) {
    if (item.url && urlCoordsMap[item.url]) {
        const c = urlCoordsMap[item.url];
        return /** @type {[number, number]} */ ([c.lat, c.lng]);
    }

    if (item.address && item.address.location) {
        const a = parseFloat(item.address.location.latitude);
        const b = parseFloat(item.address.location.longitude);
        if (!isNaN(a) && !isNaN(b)) {
            const normalized = normalizeLatLngPair(a, b);
            if (normalized) return /** @type {[number, number]} */ (normalized);
        }
    }

    // Fallback: use region name to place pin at approximate state centre
    if (item.region) {
        const key = item.region.toLowerCase().trim();
        if (REGION_FALLBACK_COORDS[key]) {
            console.warn(`Using region fallback coords for "${item.title || item.region}"`);
            return /** @type {[number, number]} */ (REGION_FALLBACK_COORDS[key]);
        }
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

    if (wixUri.startsWith('wix:image://v1/')) {
        const withoutPrefix = wixUri.replace('wix:image://v1/', '');
        const fileId = withoutPrefix.split('/')[0];
        if (fileId) {
            return `https://static.wixstatic.com/media/${fileId}`;
        }
    }

    if (wixUri.startsWith('http')) {
        const lower = wixUri.toLowerCase();
        const hasImageExt = /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?|#|$)/.test(lower);
        if (hasImageExt || lower.includes('wixstatic.com') || lower.includes('static.')) {
            return wixUri;
        }
        console.warn(`image looks like a website URL, not an image: ${wixUri}`);
        return '';
    }

    console.warn('Could not convert image URI:', wixUri);
    return '';
}

async function loadCmsData() {
    try {
        console.log("Fetching map data from ShriGuruBhagwatCenters CMS collection...");
        const result = await wixData.query("ShriGuruBhagwatCenters")
            .limit(1000)
            .find();

        const items = result.items || [];
        console.log(`Fetched ${items.length} records from Wix CMS.`);

        // Only resolve URLs if they are short links and we don't already have address.location
        const urlsToResolve = items.filter(item => {
            if (!item.url) return false;
            // if we already have coords from address, don't resolve
            if (item.address && item.address.location && item.address.location.latitude) return false;
            return true;
        }).map(item => item.url);

        let resolvedCoords = [];
        if (urlsToResolve.length > 0) {
            console.log(`Resolving ${urlsToResolve.length} map links in one batch call...`);
            resolvedCoords = await resolveCoordsFromShortLinks(urlsToResolve);
        }

        const urlCoordsMap = {};
        let resolvedIndex = 0;
        items.forEach(item => {
            if (item.url && !(item.address && item.address.location && item.address.location.latitude)) {
                urlCoordsMap[item.url] = resolvedCoords[resolvedIndex++] || null;
            }
        });

        const countries = [];
        const temples = [];
        const seenCountries = new Set();

        items.forEach(item => {
            const coords = getCoordsForItem(item, urlCoordsMap);
            if (!coords) {
                console.warn(`Skipping item "${item.title || 'unknown'}" — no valid coordinates`);
                return;
            }

            const name = item.title || '';
            let state = '';
            if (item.address && item.address.subdivisions && item.address.subdivisions.length > 0) {
                state = item.address.subdivisions[0].name;
            } else if (item.region) {
                state = item.region;
            }
            
            const country = (item.address && item.address.countryFullname) ? item.address.countryFullname : 'India';
            const countryKey = country.toLowerCase().trim();
            const image = wixImageToUrl(item.image || '');
            // Build a unique Google Maps directions link from the resolved coordinates
            // (item.url is the short-link used for coord resolution — often shared across items)
            const locationUrl = `https://www.google.com/maps/dir/?api=1&destination=${coords[0]},${coords[1]}`;
            const video = item.gbCenterVideo || '';

            if (!name) {
                console.warn(`Skipping item — missing title`);
                return;
            }

            temples.push({ name, state, country, coords, image, isWorld: false, locationUrl, video });
            console.log(`Center added: ${name} (${country}) at [${coords}]`);
        });

        if (!seenCountries.has('india')) {
            countries.push({ name: 'India', coords: INDIA_FALLBACK.coords, zoom: INDIA_FALLBACK.zoom });
        }

        cachedCountries = countries;
        cachedTemples = temples;

        console.log(`CMS Data normalized: ${cachedCountries.length} countries, ${cachedTemples.length} centers.`);
        isDataLoaded = true;

        sendDataToMap();

    } catch (error) {
        console.error("Failed to load map data from ShriGuruBhagwatCenters collection:", error);
    }
}

function sendDataToMap() {
    if (isDataLoaded && isIframeReady && !hasSentData) {
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
