import wixData from 'wix-data';
import wixLocation from 'wix-location';
import { resolveCoordsFromShortLinks } from 'backend/resolveMapLink';

const MAP_COMPONENT_ID = "#htmlMap";
const INDIA_FALLBACK = { coords: [22.9734, 78.6569], zoom: 5 };

let cachedCountries = null;
let cachedTemples = null;
let isDataLoaded = false;
let isIframeReady = false;

$w.onReady(() => {
    loadCmsData();

    $w(MAP_COMPONENT_ID).onMessage((event) => {
        if (event.data?.type === "READY") {
            isIframeReady = true;
            sendDataToMap();
        } else if (event.data?.type === 'NAVIGATE') {
            wixLocation.to(event.data.href);
        } else if (event.data?.type === 'EXTERNAL_URL') {
            wixLocation.to(event.data.href);
        }
    });
});

function getCoordsForItem(item, urlCoordsMap) {
    // 1. Direct lat/lng fields (highest priority - DB source of truth)
    let lat = parseFloat(item.templeLatitude);
    let lng = parseFloat(item.templeLongitude);

    if (!isNaN(lat) && !isNaN(lng)) {
        if (isValidLatLng(lat, lng)) {
            console.log(`✓ Using DB coords for ${item.templeName}: [${lat}, ${lng}]`);
            return [lat, lng];
        }
        if (isValidLatLng(lng, lat)) {
            console.log(`✓ Using DB coords (swapped) for ${item.templeName}: [${lng}, ${lat}]`);
            return [lng, lat]; // swapped
        }
    }

    // 2. Short URL (fallback - lower priority than DB)
    if (item.templeLocation && urlCoordsMap[item.templeLocation]) {
        const c = urlCoordsMap[item.templeLocation];
        if (c && isValidLatLng(c.lat, c.lng)) {
            console.log(`✓ Using resolved short-link for ${item.templeName}: [${c.lat}, ${c.lng}]`);
            return [c.lat, c.lng];
        }
    }

    // 3. India fallback
    if ((item.viewType || '').toLowerCase().includes('world') && 
        (item.countryName || '').toLowerCase() === 'india') {
        console.log(`✓ Using India fallback for ${item.templeName}`);
        return INDIA_FALLBACK.coords;
    }

    return null;
}

function isValidLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
           Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

async function loadCmsData() {
    try {
        const result = await wixData.query("TempleLocationMap").limit(1000).find();
        const items = result.items || [];

        // Resolve all short links in one batch
        const urlsToResolve = items
            .filter(i => i.templeLocation)
            .map(i => i.templeLocation);

        let resolvedCoords = [];
        if (urlsToResolve.length) {
            resolvedCoords = await resolveCoordsFromShortLinks(urlsToResolve);
        }

        const urlCoordsMap = {};
        items.forEach((item, i) => {
            if (item.templeLocation) {
                urlCoordsMap[item.templeLocation] = resolvedCoords.shift() || null;
            }
        });

        const countries = [];
        const temples = [];
        const seen = new Set();

        items.forEach(item => {
            const coords = getCoordsForItem(item, urlCoordsMap);
            if (!coords) {
                console.warn(`Skipped ${item.templeName}: no coords`);
                return;
            }

            const name = item.templeName || '';
            const country = item.countryName || '';
            const state = item.regionType || '';
            const image = wixImageToUrl(item.templeImage);
            const viewType = (item.viewType || '').toLowerCase().trim();
            const locationUrl = item.templeLocation || '';
            const tour = item.youtubeLink || item.tourLink || '';

            const entry = {
                name, state, country, coords,
                image: image || '',
                isWorld: viewType === 'world',
                locationUrl, tour
            };

            if (viewType === 'world') {
                const key = country.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    countries.push({ name: country, coords, zoom: 5 });
                }
                temples.push(entry);
            } else {
                temples.push(entry);
            }
        });

        // Ensure India exists
        if (!seen.has('india')) {
            countries.push({ name: 'India', coords: INDIA_FALLBACK.coords, zoom: INDIA_FALLBACK.zoom });
        }

        cachedCountries = countries;
        cachedTemples = temples;
        isDataLoaded = true;
        sendDataToMap();

    } catch (e) {
        console.error("CMS load failed", e);
    }
}

function wixImageToUrl(uri) {
    if (!uri) return '';
    if (uri.startsWith('wix:image://v1/')) {
        const id = uri.split('/')[2].split('#')[0];
        return `https://static.wixstatic.com/media/${id}`;
    }
    return uri.startsWith('http') ? uri : '';
}

function sendDataToMap() {
    if (isDataLoaded && isIframeReady) {
        $w(MAP_COMPONENT_ID).postMessage({
            type: "LOAD_DATA",
            countries: cachedCountries,
            temples: cachedTemples
        });
    }
}