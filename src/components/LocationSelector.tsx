import React, { useState, useEffect } from 'react';
import { MapPin, Search, Navigation, Locate } from 'lucide-react';
import {
  FALLBACK_CITIES,
  guessTimezoneFromCoords,
  nominatimToCityData,
  type CityData,
  type NominatimResult
} from '../lib/cities';

interface LocationSelectorProps {
  label: string;
  userName: string;
  setUserName: (val: string) => void;
  selectedCity: CityData;
  onCitySelect: (city: CityData) => void;
  colorTheme: 'primary' | 'secondary';
  /** Read-only when the other participant owns this side in a session. */
  disabled?: boolean;
}

export const LocationSelector: React.FC<LocationSelectorProps> = ({
  label,
  userName,
  setUserName,
  selectedCity,
  onCitySelect,
  colorTheme,
  disabled = false
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [apiResults, setApiResults] = useState<CityData[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  // Debounced Nominatim fetch (setState only inside async callbacks)
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (trimmed.length < 3) return;

    let cancelled = false;
    const delayDebounce = setTimeout(async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(
            trimmed
          )}&limit=5`,
          {
            headers: {
              'Accept-Language': 'en'
            }
          }
        );
        if (!res.ok) throw new Error(`Nominatim search failed: ${res.status}`);
        const data = (await res.json()) as NominatimResult[];
        if (!cancelled) setApiResults(data.map(item => nominatimToCityData(item)));
      } catch (error) {
        console.error('Nominatim search failed, using fallback:', error);
        if (!cancelled) setApiResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(delayDebounce);
      // A cancelled in-flight fetch would otherwise never reset `loading`
      setLoading(false);
    };
  }, [searchQuery]);

  // Suggestions are derived during render from apiResults + local fallback matches
  const trimmed = searchQuery.trim();
  const localMatches = trimmed
    ? FALLBACK_CITIES.filter(
        c =>
          c.name.toLowerCase().includes(trimmed.toLowerCase()) ||
          c.country.toLowerCase().includes(trimmed.toLowerCase())
      )
    : FALLBACK_CITIES.slice(0, 5);
  const effectiveApi = trimmed.length >= 3 ? apiResults : [];
  const suggestions = [...effectiveApi, ...localMatches].filter(
    (city, idx, self) => self.findIndex(c => c.name === city.name && c.country === city.country) === idx
  );

  const handleSelect = (city: CityData) => {
    onCitySelect(city);
    setSearchQuery('');
    setShowDropdown(false);
  };

  const geoSupported = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  const handleUseMyLocation = () => {
    setGeoError(null);
    if (!geoSupported) {
      setGeoError('Geolocation is not supported by this browser.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`,
            {
              headers: {
                'Accept-Language': 'en'
              }
            }
          );
          if (!res.ok) throw new Error(`Reverse geocode failed: ${res.status}`);
          const data = (await res.json()) as NominatimResult;
          const city = nominatimToCityData(data, latitude, longitude);
          onCitySelect(city);
          setSearchQuery('');
          setShowDropdown(false);
        } catch (error) {
          console.error('Reverse geocoding failed:', error);
          // Fall back to a coordinate-derived city so geolocation still works
          // when Nominatim is down or rate-limited during a live demo.
          const fallbackCity: CityData = {
            name: `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`,
            country: '',
            lat: latitude,
            lng: longitude,
            timezone: guessTimezoneFromCoords(latitude, longitude)
          };
          onCitySelect(fallbackCity);
          setSearchQuery('');
          setShowDropdown(false);
          setGeoError('Could not look up a city name — using your coordinates.');
        } finally {
          setLocating(false);
        }
      },
      (error) => {
        setLocating(false);
        let message = 'Could not determine your location.';
        if (error.code === error.PERMISSION_DENIED) message = 'Location permission denied.';
        else if (error.code === error.POSITION_UNAVAILABLE) message = 'Location signal unavailable.';
        else if (error.code === error.TIMEOUT) message = 'Location request timed out.';
        setGeoError(message);
      },
      { timeout: 10000 }
    );
  };

  const latDirection = selectedCity.lat >= 0 ? 'N' : 'S';
  const lngDirection = selectedCity.lng >= 0 ? 'E' : 'W';

  return (
    <div className="glass-panel" style={{ position: 'relative' }}>
      <div className="flex-between" style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <MapPin size={20} color={colorTheme === 'primary' ? 'var(--primary)' : 'var(--secondary)'} />
          {label}
        </h3>
        <span className={`badge ${colorTheme === 'primary' ? 'badge-primary' : 'badge-accent'}`}>
          Active
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <label htmlFor={`username-${label}`}>User Name</label>
          <input
            id={`username-${label}`}
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="Enter name..."
            disabled={disabled}
          />
        </div>

        <div style={{ position: 'relative' }}>
          <div className="flex-between" style={{ marginBottom: '6px' }}>
            <label htmlFor={`search-${label}`} style={{ marginBottom: 0 }}>
              Location (City)
            </label>
            <button
              type="button"
              onClick={handleUseMyLocation}
              disabled={disabled || !geoSupported || locating}
              className="btn btn-outline"
              style={{ padding: '5px 10px', fontSize: '11px', borderRadius: 'var(--radius-sm)', gap: '6px' }}
              aria-label="Use my current location"
            >
              <Locate size={12} color={locating ? 'var(--primary)' : 'var(--text-secondary)'} />
              {locating ? 'Locating...' : 'Use my location'}
            </button>
          </div>
          <div style={{ position: 'relative' }}>
            <input
              id={`search-${label}`}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              placeholder={`${selectedCity.name}, ${selectedCity.country}`}
              style={{ paddingRight: '40px' }}
              disabled={disabled}
            />
            <Search
              size={18}
              style={{
                position: 'absolute',
                right: '12px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)'
              }}
            />
          </div>

          {geoError && (
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#f87171' }}>
              {geoError}
            </div>
          )}

          {showDropdown && (
            <ul
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid var(--border-glow)',
                borderRadius: 'var(--radius-md)',
                marginTop: '6px',
                maxHeight: '200px',
                overflowY: 'auto',
                zIndex: 10,
                listStyle: 'none',
                boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(10px)'
              }}
            >
              {loading && (
                <li style={{ padding: '12px', color: 'var(--text-muted)', fontSize: '14px' }}>
                  Searching satellite locations...
                </li>
              )}
              {suggestions.map((city, idx) => (
                <li
                  key={idx}
                  onMouseDown={() => handleSelect(city)}
                  style={{
                    padding: '10px 16px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: idx === suggestions.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(99, 102, 241, 0.15)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ fontWeight: 500 }}>{city.name}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{city.country}</span>
                </li>
              ))}
              {suggestions.length === 0 && !loading && (
                <li style={{ padding: '12px', color: 'var(--text-muted)', fontSize: '14px' }}>
                  No locations found. Try another spelling.
                </li>
              )}
            </ul>
          )}
        </div>

        <div
          style={{
            marginTop: '8px',
            background: 'rgba(255,255,255,0.02)',
            padding: '10px 14px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid rgba(255,255,255,0.04)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '13px'
          }}
        >
          <Navigation size={14} color="var(--text-muted)" />
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Coordinates: </span>
            <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>
              {Math.abs(selectedCity.lat).toFixed(4)}°{latDirection}, {Math.abs(selectedCity.lng).toFixed(4)}°{lngDirection}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
