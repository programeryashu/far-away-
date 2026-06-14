import React, { useState, useEffect } from 'react';
import { MapPin, Search, Navigation } from 'lucide-react';

export interface CityData {
  name: string;
  country: string;
  lat: number;
  lng: number;
  timezone: string;
}

export const FALLBACK_CITIES: CityData[] = [
  { name: 'San Francisco', country: 'United States', lat: 37.7749, lng: -122.4194, timezone: 'America/Los_Angeles' },
  { name: 'Tokyo', country: 'Japan', lat: 35.6762, lng: 139.6503, timezone: 'Asia/Tokyo' },
  { name: 'London', country: 'United Kingdom', lat: 51.5074, lng: -0.1278, timezone: 'Europe/London' },
  { name: 'Mumbai', country: 'India', lat: 19.0760, lng: 72.8777, timezone: 'Asia/Kolkata' },
  { name: 'Sydney', country: 'Australia', lat: -33.8688, lng: 151.2093, timezone: 'Australia/Sydney' },
  { name: 'Paris', country: 'France', lat: 48.8566, lng: 2.3522, timezone: 'Europe/Paris' },
  { name: 'New York', country: 'United States', lat: 40.7128, lng: -74.0060, timezone: 'America/New_York' },
  { name: 'Berlin', country: 'Germany', lat: 52.5200, lng: 13.4050, timezone: 'Europe/Berlin' },
  { name: 'Cairo', country: 'Egypt', lat: 30.0444, lng: 31.2357, timezone: 'Africa/Cairo' },
  { name: 'Rio de Janeiro', country: 'Brazil', lat: -22.9068, lng: -43.1729, timezone: 'America/Sao_Paulo' },
  { name: 'Cape Town', country: 'South Africa', lat: -33.9249, lng: 18.4241, timezone: 'Africa/Johannesburg' }
];

interface LocationSelectorProps {
  label: string;
  userName: string;
  setUserName: (val: string) => void;
  selectedCity: CityData;
  onCitySelect: (city: CityData) => void;
  colorTheme: 'primary' | 'secondary';
}

export const LocationSelector: React.FC<LocationSelectorProps> = ({
  label,
  userName,
  setUserName,
  selectedCity,
  onCitySelect,
  colorTheme
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<CityData[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // Auto-search fallback cities locally
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSuggestions(FALLBACK_CITIES.slice(0, 5));
      return;
    }

    const localMatches = FALLBACK_CITIES.filter(c =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.country.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (searchQuery.length >= 3) {
      const delayDebounce = setTimeout(async () => {
        setLoading(true);
        try {
          // Attempt Nominatim fetch
          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(
              searchQuery
            )}&limit=5`,
            {
              headers: {
                'Accept-Language': 'en'
              }
            }
          );
          if (res.ok) {
            const data = await res.json();
            const apiCities: CityData[] = data.map((item: any) => {
              // Try to map to standard TZ by coordinate approximations or simple rules
              // If not found, we use simple timezone logic
              const lat = parseFloat(item.lat);
              const lng = parseFloat(item.lon);
              
              // Approximate timezone name based on longitude for lookup if API fails
              const timezone = guessTimezoneFromCoords(lat, lng);
              const cityName = item.address.city || item.address.town || item.address.suburb || item.display_name.split(',')[0];
              const countryName = item.address.country || '';

              return {
                name: cityName,
                country: countryName,
                lat,
                lng,
                timezone
              };
            });
            
            // Combine with local matches
            setSuggestions([...apiCities, ...localMatches].filter(
              (city, idx, self) => self.findIndex(c => c.name === city.name && c.country === city.country) === idx
            ));
          } else {
            setSuggestions(localMatches);
          }
        } catch (error) {
          console.error("Nominatim search failed, using fallback:", error);
          setSuggestions(localMatches);
        } finally {
          setLoading(false);
        }
      }, 500);

      return () => clearTimeout(delayDebounce);
    } else {
      setSuggestions(localMatches);
    }
  }, [searchQuery]);

  // Simple coordinate approximation for standard IANA Timezones
  const guessTimezoneFromCoords = (lat: number, lng: number): string => {
    // Basic approximate mapping
    if (lng > 60 && lng < 95 && lat > 5 && lat < 35) return 'Asia/Kolkata'; // India
    if (lng > 120 && lng < 150 && lat > 20 && lat < 50) return 'Asia/Tokyo'; // Japan
    if (lng > 110 && lng < 125 && lat > -40 && lat < -10) return 'Australia/Perth';
    if (lng > 135 && lng < 155 && lat > -45 && lat < -10) return 'Australia/Sydney';
    if (lng > -125 && lng < -114 && lat > 32 && lat < 49) return 'America/Los_Angeles';
    if (lng > -80 && lng < -65 && lat > 35 && lat < 48) return 'America/New_York';
    if (lng > -98 && lng < -80 && lat > 25 && lat < 49) return 'America/Chicago';
    if (lng > -10 && lng < 2 && lat > 50 && lat < 60) return 'Europe/London';
    if (lng > 2 && lng < 8 && lat > 42 && lat < 51) return 'Europe/Paris';
    if (lng > 8 && lng < 16 && lat > 47 && lat < 55) return 'Europe/Berlin';
    if (lng > 25 && lng < 35 && lat > 28 && lat < 32) return 'Africa/Cairo';
    if (lng > -48 && lng < -38 && lat > -25 && lat < -15) return 'America/Sao_Paulo';
    
    // Very simple fallback: group by offset hours
    const offset = Math.round(lng / 15);
    // Format timezone as Etc/GMT-x or Etc/GMT+x (Note: POSIX timezone signs are inverted in Etc/GMT names!)
    const gmtOffset = -offset;
    const gmtSign = gmtOffset >= 0 ? '+' : '';
    return `Etc/GMT${gmtSign}${gmtOffset}`;
  };

  const handleSelect = (city: CityData) => {
    onCitySelect(city);
    setSearchQuery('');
    setShowDropdown(false);
  };

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
          />
        </div>

        <div style={{ position: 'relative' }}>
          <label htmlFor={`search-${label}`}>Location (City)</label>
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
              {selectedCity.lat.toFixed(4)}°N, {selectedCity.lng.toFixed(4)}°E
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
