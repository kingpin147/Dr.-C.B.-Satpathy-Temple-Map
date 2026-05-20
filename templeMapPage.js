import wixData from 'wix-data';

// Variables to cache fetched data and coordinate readiness
let cachedCountries = null;
let cachedTemples = null;
let isDataLoaded = false;
let isIframeReady = false;
let hasSentData = false;

// HTML Component ID on your Wix Page. Please ensure your map component ID matches this.
const MAP_COMPONENT_ID = "#htmlMap";

$w.onReady(function () {
    // 1. Immediately kick off data query from the unified collection
    loadCmsData();

    // 2. Listen for the "READY" event from the HTML component
    $w(MAP_COMPONENT_ID).onMessage((event) => {
        if (event.data && event.data.type === "READY") {
            console.log("Map HTML Component is ready to receive data.");
            isIframeReady = true;
            sendDataToMap();
        }
    });
});

/**
 * Fetches data from the single "TempleLocationMap" Wix Collection and normalizes it
 */
async function loadCmsData() {
    try {
        console.log("Fetching map data from TempleLocationMap CMS collection...");
        const result = await wixData.query("TempleLocationMap")
            .limit(1000)
            .find();
        
        const items = result.items || [];
        console.log(`Fetched ${items.length} records from Wix CMS.`);

        // Default zoom levels for countries in World View
        const countryZoomMap = {
            "india": 5,
            "usa": 4,
            "australia": 4,
            "sri lanka": 7,
            "uk": 6
        };

        // 1. Filter and map World View (Countries)
        const countries = items
            .filter(item => item.viewType && item.viewType.toLowerCase().trim() === "world")
            .map(item => {
                const name = item.countryName || "";
                const lat = parseFloat(item.templeLatitude);
                const lng = parseFloat(item.templeLongitude);
                const normalizedNameLower = name.toLowerCase().trim();
                const zoom = countryZoomMap[normalizedNameLower] || 4;
                return {
                    name,
                    coords: [lat, lng],
                    zoom
                };
            })
            .filter(c => c.name && !isNaN(c.coords[0]) && !isNaN(c.coords[1]));

        // 2. Filter and map India View (Temples) - matches any viewType that is not "world"
        const temples = items
            .filter(item => item.viewType && item.viewType.toLowerCase().trim() !== "world")
            .map(item => {
                const name = item.templeName || "";
                const state = item.regionType || "";
                const country = item.countryName || "";
                const lat = parseFloat(item.templeLatitude);
                const lng = parseFloat(item.templeLongitude);
                return {
                    name,
                    state,
                    country,
                    coords: [lat, lng]
                };
            })
            .filter(t => t.name && !isNaN(t.coords[0]) && !isNaN(t.coords[1]));

        cachedCountries = countries;
        cachedTemples = temples;

        console.log(`CMS Data normalized: ${cachedCountries.length} countries, ${cachedTemples.length} temples.`);
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
        $w(MAP_COMPONENT_ID).postMessage({
            type: "LOAD_DATA",
            countries: cachedCountries,
            temples: cachedTemples
        });
        hasSentData = true;
        console.log("Successfully posted CMS data to Map HTML component.");
    }
}
