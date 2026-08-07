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

export interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: { city?: string; town?: string; suburb?: string; country?: string };
}

// Simple coordinate approximation for standard IANA Timezones
export const guessTimezoneFromCoords = (lat: number, lng: number): string => {
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

export const nominatimToCityData = (
  item: NominatimResult,
  fallbackLat?: number,
  fallbackLng?: number
): CityData => {
  const lat = fallbackLat ?? parseFloat(item.lat);
  const lng = fallbackLng ?? parseFloat(item.lon);
  const timezone = guessTimezoneFromCoords(lat, lng);
  const cityName = item.address?.city || item.address?.town || item.address?.suburb || item.display_name.split(',')[0];
  const countryName = item.address?.country || '';
  return { name: cityName, country: countryName, lat, lng, timezone };
};

export const isValidCityData = (value: unknown): value is CityData => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.name !== 'string' ||
    typeof v.country !== 'string' ||
    typeof v.timezone !== 'string' ||
    typeof v.lat !== 'number' || !Number.isFinite(v.lat) ||
    typeof v.lng !== 'number' || !Number.isFinite(v.lng)
  ) {
    return false;
  }
  // Reject out-of-range coordinates (lat: -90..90, lng: -180..180)
  if (Math.abs(v.lat) > 90 || Math.abs(v.lng) > 180) return false;
  // Reject timezone strings that aren't real IANA zones (avoids RangeError in Intl usage)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v.timezone });
  } catch {
    return false;
  }
  return true;
};
