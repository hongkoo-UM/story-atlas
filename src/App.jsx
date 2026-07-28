import { useEffect, useRef, useState, useMemo } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import storiesData from "./stories.json";
import "./App.css";

const ALL_GENRES = [...new Set(storiesData.map((s) => s.genre))].sort();
const ALL_MEDIA = [...new Set(storiesData.map((s) => s.medium))].sort();
const ALL_YEARS = storiesData.map((s) => s.year);
const MIN_YEAR_BOUND = Math.min(...ALL_YEARS);
const MAX_YEAR_BOUND = Math.max(...ALL_YEARS);

// Build tick marks for the timeline axis, greedily thinning out candidate
// years (every 50 years) so consecutive labels always stay a minimum
// percentage of the axis width apart. A fixed list of "nice" years breaks
// down here because the dataset spans ~4,100 years but is heavily weighted
// toward the last few centuries, so round numbers like 1700/1800/1900/1950
// end up crammed into a tiny sliver of pixel space and overlap.
function buildTimelineTicks(min, max, minGapPct = 8) {
  const span = max - min || 1;
  const step = 50;
  const candidates = [];
  for (let y = Math.ceil(min / step) * step; y <= max; y += step) {
    candidates.push(y);
  }
  if (candidates[0] !== min) candidates.unshift(min);
  if (candidates[candidates.length - 1] !== max) candidates.push(max);

  const picked = [];
  let lastPct = -Infinity;
  candidates.forEach((y, i) => {
    const pct = ((y - min) / span) * 100;
    const isLast = i === candidates.length - 1;
    if (pct - lastPct >= minGapPct || isLast) {
      picked.push(y);
      lastPct = pct;
    }
  });
  return picked;
}

// The axis itself extends a bit past the newest story (padded to at least
// 2030) so the most recent points have breathing room instead of sitting
// flush against the right edge of the timeline.
const TIMELINE_AXIS_MAX = Math.max(MAX_YEAR_BOUND, 2030);

// Fixed reference points for the timeline axis, so the scale stays stable
// regardless of which filters are currently active. Built out to
// TIMELINE_AXIS_MAX (not just the newest story year) so the tick marks
// actually reflect the padded axis instead of stopping short of it.
const TIMELINE_TICKS = buildTimelineTicks(MIN_YEAR_BOUND, TIMELINE_AXIS_MAX);

// Deterministic pseudo-random value in [0, 1) from a story's title, used to
// spread same-year/near-year points vertically on the timeline so they don't
// all stack on the same pixel (the same overlap problem the map markers had).
function hashToUnit(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 1000) / 1000;
}

function formatYear(year) {
  return year < 0 ? `${Math.abs(year)} BCE` : `${year}`;
}

function TimelineView({ stories, onSelect, onHover, onHoverEnd }) {
  const span = TIMELINE_AXIS_MAX - MIN_YEAR_BOUND || 1;

  return (
    <div className="timeline">
      <div className="timeline-track">
        {stories.map((story) => {
          const leftPct = ((story.year - MIN_YEAR_BOUND) / span) * 100;
          const topPct = 8 + hashToUnit(story.title) * 84;
          return (
            <div
              key={story.title}
              className="timeline-point"
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
              onClick={() => onSelect(story)}
              onMouseEnter={(e) => onHover(story, e)}
              onMouseMove={(e) => onHover(story, e)}
              onMouseLeave={onHoverEnd}
            />
          );
        })}
      </div>
      <div className="timeline-axis">
        {TIMELINE_TICKS.filter((t) => t >= MIN_YEAR_BOUND && t <= TIMELINE_AXIS_MAX).map(
          (tick, i, arr) => {
            const leftPct = ((tick - MIN_YEAR_BOUND) / span) * 100;
            // Center every label except the first/last, which get anchored
            // inward so they don't spill past the edge of the timeline and
            // get clipped.
            let labelAlign = "translateX(-50%)";
            if (i === 0) labelAlign = "translateX(0%)";
            if (i === arr.length - 1) labelAlign = "translateX(-100%)";
            return (
              <div key={tick} className="timeline-tick" style={{ left: `${leftPct}%` }}>
                <span style={{ transform: labelAlign }}>{formatYear(tick)}</span>
              </div>
            );
          }
        )}
      </div>
    </div>
  );
}

function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [viewMode, setViewMode] = useState("map"); // "map" | "timeline"
  const [selectedStory, setSelectedStory] = useState(null);
  const [activeGenres, setActiveGenres] = useState(ALL_GENRES);
  const [activeMedia, setActiveMedia] = useState(ALL_MEDIA);
  const [minYear, setMinYear] = useState(MIN_YEAR_BOUND);
  const [maxYear, setMaxYear] = useState(MAX_YEAR_BOUND);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [hoverStory, setHoverStory] = useState(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });

  function handleHover(story, e) {
    setHoverStory(story);
    setHoverPos({ x: e.clientX, y: e.clientY });
  }

  // The filtered list recalculates whenever a filter changes
  // (this is the direct equivalent of Shiny's reactive({ stories %>% filter(...) }))
  const filteredStories = useMemo(() => {
    return storiesData.filter(
      (s) =>
        activeGenres.includes(s.genre) &&
        activeMedia.includes(s.medium) &&
        s.year >= minYear &&
        s.year <= maxYear
    );
  }, [activeGenres, activeMedia, minYear, maxYear]);

  // Search results are computed against the full dataset (not the active filters),
  // so you can always find a story by name regardless of what's currently checked.
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return storiesData
      .filter((s) => s.title.toLowerCase().includes(query))
      .slice(0, 8);
  }, [searchQuery]);

  // Other known variants/adaptations of the same underlying narrative as the
  // currently selected story (e.g. the regional Ramayana retellings).
  const relatedVariants = useMemo(() => {
    if (!selectedStory || !selectedStory.narrativeFamily) return [];
    return storiesData.filter(
      (s) =>
        s.narrativeFamily === selectedStory.narrativeFamily &&
        s.title !== selectedStory.title
    );
  }, [selectedStory]);

  // Jump to a specific story from anywhere in the UI (search, related-variant
  // links, the timeline's "Find on map" button, etc.): select it, switch to
  // the map, and fly the camera to it. Zoom is kept fairly wide (regional,
  // not street-level) so you land with some geographic context instead of
  // being zoomed in tight on a single point.
  function jumpToStory(story) {
    setSelectedStory(story);
    setViewMode("map");
    if (mapRef.current) {
      mapRef.current.flyTo({ center: [story.lon, story.lat], zoom: 5, essential: true });
    }
    setSearchQuery("");
    setSearchOpen(false);
  }

  useEffect(() => {
    if (mapRef.current) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [20, 20],
      zoom: 1.5,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");

    // The "load" event (waits for full tile-load completion) never fires in
    // this environment, and isStyleLoaded() stays false indefinitely even
    // once the style has genuinely finished parsing - so neither can be used
    // as the trigger. "style.load" (the style is parsed and its layers are
    // queryable/editable) fires reliably and is all this setup needs, so run
    // directly off that instead, guarded so it only runs once.
    let styleSetupDone = false;
    const runStyleSetup = () => {
      if (styleSetupDone) return;
      styleSetupDone = true;

      // Recolor the base map to a muted, cohesive palette instead of relying
      // on a separate remote style. Layers are found by type/source-layer
      // rather than a hardcoded id, since that stays correct even if the
      // "liberty" style's internal layer names change in a future update.
      // The "background" layer is what actually paints the open ocean at
      // world zoom - the "water" vector fill barely has any geometry that
      // far out, so it was setting a color nothing would show. Swap the
      // roles: background = ocean blue, water fill = same tone so coastal/
      // inland water blends in seamlessly once it does start rendering.
      const styleLayers = mapRef.current.getStyle().layers || [];
      const oceanColor = "#7fb0c2";
      const backgroundLayer = styleLayers.find((l) => l.type === "background");
      if (backgroundLayer) {
        mapRef.current.setPaintProperty(backgroundLayer.id, "background-color", oceanColor);
      }
      const waterLayer = styleLayers.find(
        (l) => l.type === "fill" && l["source-layer"] === "water"
      );
      if (waterLayer) {
        mapRef.current.setPaintProperty(waterLayer.id, "fill-color", oceanColor);
      }
      // "liberty" draws a shaded-relief terrain raster (green/brown, with a
      // maxzoom of 7) that is the *only* thing giving continents their shape
      // at world-view zoom - the vector land/water fill layers mostly don't
      // render until much closer in. Fully desaturating it read as flat and
      // colorless, so instead give it a warm sepia tone: partial desaturation,
      // a hue shift toward amber/tan, and a brightness lift, so it stays soft
      // but still has some warmth and definition instead of going grey.
      const terrainLayer = styleLayers.find((l) => l.type === "raster");
      if (terrainLayer) {
        mapRef.current.setPaintProperty(terrainLayer.id, "raster-saturation", -0.2);
        mapRef.current.setPaintProperty(terrainLayer.id, "raster-contrast", 0.05);
        mapRef.current.setPaintProperty(terrainLayer.id, "raster-brightness-min", 0.32);
        mapRef.current.setPaintProperty(terrainLayer.id, "raster-brightness-max", 0.95);
        mapRef.current.setPaintProperty(terrainLayer.id, "raster-hue-rotate", 25);
      }
      // Recolor the close-zoom vector landcover fills (woods, grass, parks)
      // to match the same warm palette, so zooming in doesn't jump from the
      // sepia-toned raster to vivid green.
      styleLayers
        .filter(
          (l) =>
            l.type === "fill" &&
            (l["source-layer"] === "landcover" || l["source-layer"] === "park")
        )
        .forEach((l) => {
          mapRef.current.setPaintProperty(l.id, "fill-color", "#ddc793");
        });

      // A source + line layer for drawing connections between narrative variants.
      mapRef.current.addSource("connections", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      mapRef.current.addLayer({
        id: "connections-layer",
        type: "line",
        source: "connections",
        paint: {
          "line-color": "#2a6fdb",
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });

      setMapLoaded(true);
      // Trigger the marker-drawing effect once the map is ready
      setActiveGenres((g) => [...g]);
    };

    // "load" is kept as a fallback in case it does fire in some environments;
    // "style.load" is the one that actually fires reliably here. The guard
    // above prevents double-running if both end up firing.
    mapRef.current.on("load", runStyleSetup);
    mapRef.current.on("style.load", runStyleSetup);
  }, []);

  // Resize the map after switching back from the timeline, since a canvas
  // that was hidden with display:none needs a nudge to size itself correctly.
  useEffect(() => {
    if (viewMode !== "map" || !mapRef.current) return;
    const id = requestAnimationFrame(() => mapRef.current.resize());
    return () => cancelAnimationFrame(id);
  }, [viewMode]);

  // Redraw markers whenever the filtered list changes
  useEffect(() => {
    if (!mapRef.current) return;

    // Clear old markers first
    markersRef.current.forEach((m) => m.marker.remove());
    markersRef.current = [];
    setHoverStory(null);

    filteredStories.forEach((story) => {
      const el = document.createElement("div");
      el.className = "story-marker";
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([story.lon, story.lat])
        .addTo(mapRef.current);

      el.addEventListener("click", () => setSelectedStory(story));
      el.addEventListener("mouseenter", (e) => handleHover(story, e));
      el.addEventListener("mousemove", (e) => handleHover(story, e));
      el.addEventListener("mouseleave", () => setHoverStory(null));
      // Keep the story alongside the element so the focus-highlight effect
      // below can find the right marker without rebuilding all of them.
      markersRef.current.push({ marker, el, story });
    });
  }, [filteredStories]);

  // Put a pulsing ring around whichever marker corresponds to the currently
  // selected story, so it's obvious which point you're looking at - both
  // when clicking a marker directly and after jumping over from the
  // timeline. Runs off a class toggle rather than rebuilding markers, so it
  // stays cheap even with 500+ points on screen.
  useEffect(() => {
    markersRef.current.forEach(({ el, story }) => {
      el.classList.toggle(
        "focused",
        !!selectedStory && story.title === selectedStory.title
      );
    });
  }, [selectedStory, filteredStories]);

  // Draw connection lines from the selected story to its known narrative
  // variants/adaptations (e.g. the regional Ramayana retellings).
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const source = mapRef.current.getSource("connections");
    if (!source) return;

    if (!selectedStory || relatedVariants.length === 0) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const features = relatedVariants.map((r) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [selectedStory.lon, selectedStory.lat],
          [r.lon, r.lat],
        ],
      },
      properties: {},
    }));

    source.setData({ type: "FeatureCollection", features });
  }, [selectedStory, relatedVariants, mapLoaded]);

  function toggleGenre(genre) {
    setActiveGenres((prev) =>
      prev.includes(genre) ? prev.filter((g) => g !== genre) : [...prev, genre]
    );
  }

  function toggleMedium(medium) {
    setActiveMedia((prev) =>
      prev.includes(medium) ? prev.filter((m) => m !== medium) : [...prev, medium]
    );
  }

  return (
    <div className="app">
      <div className="sidebar">
        <h3>Genre</h3>
        {ALL_GENRES.map((g) => (
          <label key={g} className="filter-row">
            <input
              type="checkbox"
              checked={activeGenres.includes(g)}
              onChange={() => toggleGenre(g)}
            />
            {g}
          </label>
        ))}

        <h3>Medium</h3>
        {ALL_MEDIA.map((m) => (
          <label key={m} className="filter-row">
            <input
              type="checkbox"
              checked={activeMedia.includes(m)}
              onChange={() => toggleMedium(m)}
            />
            {m}
          </label>
        ))}

        <h3>Year range (negative = BCE)</h3>
        <input
          type="number"
          value={minYear}
          onChange={(e) => setMinYear(Number(e.target.value))}
        />
        <span className="year-separator"> to </span>
        <input
          type="number"
          value={maxYear}
          onChange={(e) => setMaxYear(Number(e.target.value))}
        />

        <p className="count">
          Showing {filteredStories.length} of {storiesData.length} stories
        </p>
      </div>

      <div ref={mapContainer} className={`map${viewMode !== "map" ? " map-hidden" : ""}`} />

      {viewMode === "timeline" && (
        <TimelineView
          stories={filteredStories}
          onSelect={setSelectedStory}
          onHover={handleHover}
          onHoverEnd={() => setHoverStory(null)}
        />
      )}

      <div className="view-toggle">
        <button
          className={viewMode === "map" ? "active" : ""}
          onClick={() => setViewMode("map")}
        >
          Map view
        </button>
        <button
          className={viewMode === "timeline" ? "active" : ""}
          onClick={() => setViewMode("timeline")}
        >
          Timeline view
        </button>
      </div>

      <div className="search-bar">
        <input
          type="text"
          placeholder="Search for a story..."
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
        />
        {searchOpen && searchQuery.trim() !== "" && (
          <ul className="search-results">
            {searchResults.length === 0 && (
              <li className="search-empty">No stories found</li>
            )}
            {searchResults.map((story) => (
              <li key={story.title} onClick={() => jumpToStory(story)}>
                {story.title}
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedStory && (
        <div className="detail-panel">
          <h2>{selectedStory.title}</h2>
          <p className="meta">
            {selectedStory.country} &middot; {selectedStory.medium} &middot;{" "}
            {selectedStory.genre} &middot; {selectedStory.era_label}
          </p>
          <p className="author">By {selectedStory.author}</p>
          <p className="description">{selectedStory.description}</p>
          <p className="keywords">Keywords: {selectedStory.keywords}</p>

          {relatedVariants.length > 0 && (
            <div className="related-variants">
              <p className="related-heading">
                Related narrative variants ({selectedStory.narrativeFamily}):
              </p>
              <ul>
                {relatedVariants.map((r) => (
                  <li key={r.title} onClick={() => jumpToStory(r)}>
                    {r.title} <span className="related-country">({r.country})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="detail-actions">
            {viewMode === "timeline" && (
              <button className="find-on-map" onClick={() => jumpToStory(selectedStory)}>
                Find on map
              </button>
            )}
            <button onClick={() => setSelectedStory(null)}>Close</button>
          </div>
        </div>
      )}

      {hoverStory && (() => {
        // Flip the tooltip to the left of the cursor if it would otherwise
        // spill past the right edge of the window (e.g. hovering the
        // rightmost/newest points on the timeline).
        const tooltipWidth = 240;
        const margin = 16;
        const flip = hoverPos.x + margin + tooltipWidth > window.innerWidth;
        const left = flip ? hoverPos.x - margin - tooltipWidth : hoverPos.x + margin;
        return (
          <div className="hover-tooltip" style={{ left, top: hoverPos.y + 16 }}>
            <div className="hover-title">{hoverStory.title}</div>
            <div className="hover-meta">
              {hoverStory.country} &middot; {hoverStory.medium} &middot; {hoverStory.era_label}
            </div>
            <div className="hover-author">By {hoverStory.author}</div>
          </div>
        );
      })()}
    </div>
  );
}

export default App;
