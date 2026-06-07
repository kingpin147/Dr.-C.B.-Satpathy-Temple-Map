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
 *   1. url short URL → resolved lat/lng (via backend)
 *   2. address.location DB fields
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
            const locationUrl = item.url || '';
            const video = '';

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
