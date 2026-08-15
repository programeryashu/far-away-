import React from 'react';
import { Globe } from 'lucide-react';

interface DistanceVisualizerProps {
  cityA: { name: string; country: string; lat: number; lng: number };
  cityB: { name: string; country: string; lat: number; lng: number };
  nameA: string;
  nameB: string;
}

export const DistanceVisualizer: React.FC<DistanceVisualizerProps> = ({
  cityA,
  cityB,
  nameA,
  nameB
}) => {
  // Haversine formula
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371; // Radius of the Earth in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const distance = calculateDistance(cityA.lat, cityA.lng, cityB.lat, cityB.lng);

  return (
    <div className="glass-panel full-width" style={{ position: 'relative', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '24px'
        }}
      >
        <div className="flex-between">
          <h2 style={{ fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Globe size={16} color="var(--text-secondary)" />
            Distance Between You
          </h2>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'center',
            gap: '16px',
            textAlign: 'center'
          }}
        >
          {/* Node A */}
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {nameA || 'User A'}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {cityA.name}
              {cityA.country ? `, ${cityA.country}` : ''}
            </div>
          </div>

          {/* Distance */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', minWidth: '180px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Distance</span>
            <div className="tabular" style={{ fontSize: '32px', fontWeight: 650, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
              {distance.toLocaleString(undefined, { maximumFractionDigits: 1 })}
              <span style={{ fontSize: '16px', fontWeight: 450, color: 'var(--text-secondary)', marginLeft: '6px' }}>km</span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              {(distance * 0.621371).toLocaleString(undefined, { maximumFractionDigits: 1 })} miles
            </div>
          </div>

          {/* Node B */}
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {nameB || 'User B'}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {cityB.name}
              {cityB.country ? `, ${cityB.country}` : ''}
            </div>
          </div>
        </div>

        {/* Static connection arc */}
        <div
          style={{
            width: '100%',
            height: '120px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-glass)',
            background: 'var(--bg-inset)',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 800 160" preserveAspectRatio="none" style={{ position: 'absolute', top: 0, left: 0 }}>
            <path
              d="M 120 130 Q 400 20 680 130"
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="14"
              strokeLinecap="round"
            />
            <path
              d="M 120 130 Q 400 20 680 130"
              fill="none"
              stroke="var(--primary)"
              strokeWidth="2"
              strokeLinecap="round"
              opacity="0.85"
            />
            <circle cx="120" cy="130" r="5" fill="var(--primary)" />
            <circle cx="680" cy="130" r="5" fill="var(--secondary)" />
          </svg>
        </div>
      </div>
    </div>
  );
};
