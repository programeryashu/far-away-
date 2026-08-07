import { isValidCityData, type CityData } from './cities';

export interface ConnectionState {
  a: { name: string; city: CityData };
  b: { name: string; city: CityData };
}

const toParamCity = (side: { name: string; city: CityData }) => ({
  name: side.name,
  cityName: side.city.name,
  country: side.city.country,
  lat: String(side.city.lat),
  lng: String(side.city.lng),
  timezone: side.city.timezone
});

export const buildShareUrl = (state: ConnectionState): string => {
  const a = toParamCity(state.a);
  const b = toParamCity(state.b);
  const params = new URLSearchParams();
  params.set('a', a.name);
  params.set('ac', a.cityName);
  params.set('acl', a.country);
  params.set('alat', a.lat);
  params.set('alng', a.lng);
  params.set('atz', a.timezone);
  params.set('b', b.name);
  params.set('bc', b.cityName);
  params.set('bcl', b.country);
  params.set('blat', b.lat);
  params.set('blng', b.lng);
  params.set('btz', b.timezone);
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
};

// Strict numeric parse: reject trailing junk ("12.3abc") and require a real finite number
const parseParamNumber = (raw: string): number | null => {
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export const parseShareUrl = (search = window.location.search): ConnectionState | null => {
  const params = new URLSearchParams(search);
  const get = (key: string) => params.get(key);

  const aName = get('a');
  const aCityName = get('ac');
  const aCountry = get('acl');
  const aLat = get('alat');
  const aLng = get('alng');
  const aTz = get('atz');
  const bName = get('b');
  const bCityName = get('bc');
  const bCountry = get('bcl');
  const bLat = get('blat');
  const bLng = get('blng');
  const bTz = get('btz');

  if (
    !aName || !aCityName || !aCountry || aLat === null || aLng === null || !aTz ||
    !bName || !bCityName || !bCountry || bLat === null || bLng === null || !bTz
  ) {
    return null;
  }

  const aLatNum = parseParamNumber(aLat);
  const aLngNum = parseParamNumber(aLng);
  const bLatNum = parseParamNumber(bLat);
  const bLngNum = parseParamNumber(bLng);
  if (aLatNum === null || aLngNum === null || bLatNum === null || bLngNum === null) return null;

  const cityA: CityData = {
    name: aCityName,
    country: aCountry,
    lat: aLatNum,
    lng: aLngNum,
    timezone: aTz
  };
  const cityB: CityData = {
    name: bCityName,
    country: bCountry,
    lat: bLatNum,
    lng: bLngNum,
    timezone: bTz
  };

  if (!isValidCityData(cityA) || !isValidCityData(cityB)) return null;

  return {
    a: { name: aName, city: cityA },
    b: { name: bName, city: cityB }
  };
};

export const isValidConnectionState = (value: unknown): value is ConnectionState => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const a = v.a;
  const b = v.b;
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  return (
    typeof aObj.name === 'string' &&
    typeof bObj.name === 'string' &&
    isValidCityData(aObj.city) &&
    isValidCityData(bObj.city)
  );
};
