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

function TimelineView({ stories, onSelect, onHover, onHoverEnd, selectedTitle, onDeselect }) {
  const span = TIMELINE_AXIS_MAX - MIN_YEAR_BOUND || 1;

  return (
    <div className="timeline" onClick={onDeselect}>
      <div className="timeline-track">
        {stories.map((story) => {
          const leftPct = ((story.year - MIN_YEAR_BOUND) / span) * 100;
          const topPct = 8 + hashToUnit(story.title) * 84;
          return (
            <div
              key={story.title}
              className={`timeline-point${story.title === selectedTitle ? " focused" : ""}`}
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(story);
              }}
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
  // The detail panel fades in/out instead of popping, which means it can't
  // just be mounted/unmounted in lockstep with selectedStory - it needs to
  // stay mounted (showing the old content) for the duration of the
  // fade-out, and mount hidden-then-visible (rather than already-visible)
  // for the fade-in to actually animate instead of snapping in.
  const [panelStory, setPanelStory] = useState(null);
  const [panelVisible, setPanelVisible] = useState(false);
  const panelCloseTimeoutRef = useRef(null);
  // Representative images, looked up on demand from Wikipedia's free API by
  // story title and cached by title so the same story is never fetched
  // twice. Values: "loading" while in flight, null once confirmed there's
  // no matching page/thumbnail, or the image URL once found. Coverage is
  // necessarily uneven - well-known novels/films/games tend to have a
  // Wikipedia thumbnail, but oral folklore and anonymous myths often won't.
  const [imageCache, setImageCache] = useState({});

  function fetchWikipediaSummary(pageTitle) {
    const encoded = encodeURIComponent(pageTitle.replace(/ /g, "_"));
    return fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`).then((res) =>
      res.ok ? res.json() : null
    );
  }

  function ensureStoryImage(title) {
    if (imageCache[title] !== undefined) return;
    setImageCache((prev) => ({ ...prev, [title]: "loading" }));

    fetchWikipediaSummary(title)
      .then((data) => {
        if (data?.thumbnail?.source) return data.thumbnail.source;
        // The exact title didn't turn up a usable image - either there's no
        // page by that exact name, it landed on a disambiguation page, or
        // the page has no lead image. Fall back to Wikipedia's own search
        // to find the closest matching article and try that instead, which
        // catches most cases where our title differs slightly from the
        // real article title (e.g. retellings, alternate spellings).
        return fetch(
          `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=1&srsearch=${encodeURIComponent(
            title
          )}`
        )
          .then((res) => (res.ok ? res.json() : null))
          .then((searchData) => {
            const hit = searchData?.query?.search?.[0]?.title;
            if (!hit || hit === title) return null;
            return fetchWikipediaSummary(hit).then((data2) => data2?.thumbnail?.source || null);
          });
      })
      .then((url) => {
        setImageCache((prev) => ({ ...prev, [title]: url || null }));
      })
      .catch(() => {
        setImageCache((prev) => ({ ...prev, [title]: null }));
      });
  }

  function handleHover(story, e) {
    setHoverStory(story);
    setHoverPos({ x: e.clientX, y: e.clientY });
    ensureStoryImage(story.title);
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
  // Matches on title or author, so "Homer" finds the Odyssey even if you don't
  // remember the title.
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return storiesData
      .filter(
        (s) =>
          s.title.toLowerCase().includes(query) ||
          (s.author && s.author.toLowerCase().includes(query))
      )
      .slice(0, 8);
  }, [searchQuery]);

  // Other known variants/adaptations of the same underlying narrative as the
  // story currently shown in the panel (e.g. the regional Ramayana
  // retellings). Based on panelStory rather than selectedStory so this list
  // doesn't blank out mid fade-out.
  const relatedVariants = useMemo(() => {
    if (!panelStory || !panelStory.narrativeFamily) return [];
    return storiesData.filter(
      (s) =>
        s.narrativeFamily === panelStory.narrativeFamily && s.title !== panelStory.title
    );
  }, [panelStory]);

  // Drive the detail panel's fade in/out. Opening from closed: mount with
  // the content but stay hidden for a frame, then flip visible so the
  // opacity/transform transition actually has something to animate from.
  // Switching directly between two different stories while already open
  // gets the same treatment - drop back to hidden, swap the content, then
  // fade the new story back in - rather than snapping straight to the new
  // content. Closing: fade out, then unmount after the transition finishes
  // so the old content doesn't flash away instantly.
  useEffect(() => {
    if (selectedStory) {
      if (panelCloseTimeoutRef.current) {
        clearTimeout(panelCloseTimeoutRef.current);
        panelCloseTimeoutRef.current = null;
      }
      setPanelStory(selectedStory);
      ensureStoryImage(selectedStory.title);
      setPanelVisible(false);
      // A short timeout (rather than requestAnimationFrame) to let the
      // "hidden" state actually commit before flipping back to visible -
      // rAF can simply never fire while a tab isn't the active/focused one,
      // which would leave the panel stuck invisible indefinitely.
      setTimeout(() => setPanelVisible(true), 20);
    } else {
      setPanelVisible(false);
      panelCloseTimeoutRef.current = setTimeout(() => setPanelStory(null), 260);
    }
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

    // Clicking empty map background (not a marker) closes the open detail
    // panel with the same fade-out used elsewhere. Marker elements sit
    // outside the canvas MapLibre listens on, so marker clicks don't reach
    // this handler - but el.addEventListener below also stops propagation
    // as a defensive measure in case that ever changes.
    mapRef.current.on("click", () => setSelectedStory(null));
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

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        setSelectedStory(story);
      });
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

  // Reset everything back to the default, fully-open filter state.
  function resetFilters() {
    setActiveGenres(ALL_GENRES);
    setActiveMedia(ALL_MEDIA);
    setMinYear(MIN_YEAR_BOUND);
    setMaxYear(MAX_YEAR_BOUND);
  }

  return (
    <div className="app">
      <div className="sidebar">
        <button className="reset-filters-btn" onClick={resetFilters}>
          Reset all filters
        </button>

        <div className="filter-section-header">
          <h3>Genre</h3>
          <span className="filter-quick-actions">
            <button onClick={() => setActiveGenres(ALL_GENRES)}>All</button>
            <span className="filter-quick-sep">/</span>
            <button onClick={() => setActiveGenres([])}>None</button>
          </span>
        </div>
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

        <div className="filter-section-header">
          <h3>Medium</h3>
          <span className="filter-quick-actions">
            <button onClick={() => setActiveMedia(ALL_MEDIA)}>All</button>
            <span className="filter-quick-sep">/</span>
            <button onClick={() => setActiveMedia([])}>None</button>
          </span>
        </div>
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
          selectedTitle={selectedStory?.title}
          onDeselect={() => setSelectedStory(null)}
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
          placeholder="Search by title or author..."
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
                {story.author && <span className="search-result-author"> — {story.author}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {panelStory && (
        <div className={`detail-panel${panelVisible ? " visible" : ""}`}>
          {imageCache[panelStory.title] && imageCache[panelStory.title] !== "loading" && (
            <img
              className="detail-image"
              src={imageCache[panelStory.title]}
              alt={panelStory.title}
            />
          )}
          <h2>{panelStory.title}</h2>
          <p className="meta">
            {panelStory.country} &middot; {panelStory.medium} &middot;{" "}
            {panelStory.genre} &middot; {panelStory.era_label}
          </p>
          <p className="author">By {panelStory.author}</p>
          <p className="description">{panelStory.description}</p>
          <p className="keywords">Keywords: {panelStory.keywords}</p>

          {relatedVariants.length > 0 && (
            <div className="related-variants">
              <p className="related-heading">
                Related narrative variants ({panelStory.narrativeFamily}):
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
              <button className="find-on-map" onClick={() => jumpToStory(panelStory)}>
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
        const hoverImg = imageCache[hoverStory.title];
        return (
          <div className="hover-tooltip" style={{ left, top: hoverPos.y + 16 }}>
            {hoverImg && hoverImg !== "loading" && (
              <img className="hover-image" src={hoverImg} alt="" />
            )}
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
