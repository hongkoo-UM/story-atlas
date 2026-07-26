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

function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const [selectedStory, setSelectedStory] = useState(null);
  const [activeGenres, setActiveGenres] = useState(ALL_GENRES);
  const [activeMedia, setActiveMedia] = useState(ALL_MEDIA);
  const [minYear, setMinYear] = useState(MIN_YEAR_BOUND);
  const [maxYear, setMaxYear] = useState(MAX_YEAR_BOUND);

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

  useEffect(() => {
    if (mapRef.current) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: [20, 20],
      zoom: 1.5,
    });

    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");

    mapRef.current.on("load", () => {
      // Trigger the marker-drawing effect once the map is ready
      setActiveGenres((g) => [...g]);
    });
  }, []);

  // Redraw markers whenever the filtered list changes
  useEffect(() => {
    if (!mapRef.current) return;

    // Clear old markers first
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    filteredStories.forEach((story) => {
      const el = document.createElement("div");
      el.className = "story-marker";
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([story.lon, story.lat])
        .addTo(mapRef.current);

      el.addEventListener("click", () => setSelectedStory(story));
      markersRef.current.push(marker);
    });
  }, [filteredStories]);

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
        <span> to </span>
        <input
          type="number"
          value={maxYear}
          onChange={(e) => setMaxYear(Number(e.target.value))}
        />

        <p className="count">
          Showing {filteredStories.length} of {storiesData.length} stories
        </p>
      </div>

      <div ref={mapContainer} className="map" />

      {selectedStory && (
        <div className="detail-panel">
          <h2>{selectedStory.title}</h2>
          <p className="meta">
            {selectedStory.country} &middot; {selectedStory.medium} &middot;{" "}
            {selectedStory.genre} &middot; {selectedStory.era_label}
          </p>
          <p>{selectedStory.description}</p>
          <p className="keywords">Keywords: {selectedStory.keywords}</p>
          <button onClick={() => setSelectedStory(null)}>Close</button>
        </div>
      )}
    </div>
  );
}

export default App;
