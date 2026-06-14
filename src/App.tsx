import { useState } from 'react';
import { LocationSelector, FALLBACK_CITIES, type CityData } from './components/LocationSelector';
import { DistanceVisualizer } from './components/DistanceVisualizer';
import { TimezoneSync } from './components/TimezoneSync';
import { ActivityFinder } from './components/ActivityFinder';
import { ChatBox } from './components/ChatBox';
import { Globe, Heart } from 'lucide-react';
import './App.css';

function App() {
  const [userNameA, setUserNameA] = useState('Yash');
  const [selectedCityA, setSelectedCityA] = useState<CityData>(FALLBACK_CITIES[0]); // San Francisco

  const [userNameB, setUserNameB] = useState('Kimi');
  const [selectedCityB, setSelectedCityB] = useState<CityData>(FALLBACK_CITIES[1]); // Tokyo

  return (
    <div id="root">
      {/* Header section with brand info */}
      <header style={{ borderBottom: '1px solid var(--border-glass)', background: 'rgba(7, 9, 19, 0.4)', backdropFilter: 'blur(8px)', padding: '20px 0', position: 'sticky', top: 0, zIndex: 50 }}>
        <div
          style={{
            maxWidth: '1280px',
            margin: '0 auto',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
                width: '40px',
                height: '40px',
                borderRadius: 'var(--radius-sm)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 15px rgba(99, 102, 241, 0.4)'
              }}
            >
              <Globe size={22} color="white" />
            </div>
            <div>
              <h1
                style={{
                  fontSize: '22px',
                  fontWeight: 800,
                  background: 'linear-gradient(to right, #ffffff, #c7d2fe)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  margin: 0,
                  letterSpacing: '-0.02em'
                }}
              >
                Zuup Connection Hub
              </h1>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Bridging space & time across orbits
              </p>
            </div>

        </div>
      </div></header>

      {/* Main dashboard body */}
      <main className="app-container">
        {/* Intro Hero Section */}
        <section
          style={{
            textAlign: 'center',
            padding: '40px 20px',
            borderRadius: 'var(--radius-lg)',
            background: 'radial-gradient(ellipse at center, rgba(99, 102, 241, 0.08) 0%, transparent 70%)',
            border: '1px solid rgba(255, 255, 255, 0.02)'
          }}
        >
          <h2 style={{ fontSize: '32px', fontWeight: 800, letterSpacing: '-0.03em', marginBottom: '12px' }}>
            How Far Is <span style={{ color: 'var(--primary)' }}>Far Away</span>?
          </h2>
          <p style={{ maxWidth: '600px', margin: '0 auto', fontSize: '15px' }}>
            Enter your locations below to compute distances, synchronize local day timelines, chat with low-latency route trace, and run synchronized video & sketch session mockups.
          </p>
        </section>

        {/* Node Location Configurations */}
        <section className="dashboard-grid">
          <LocationSelector
            label="Host Terminal (User A)"
            userName={userNameA}
            setUserName={setUserNameA}
            selectedCity={selectedCityA}
            onCitySelect={setSelectedCityA}
            colorTheme="primary"
          />

          <LocationSelector
            label="Remote Node (User B)"
            userName={userNameB}
            setUserName={setUserNameB}
            selectedCity={selectedCityB}
            onCitySelect={setSelectedCityB}
            colorTheme="secondary"
          />
        </section>

        {/* Distance Display Curvature */}
        <section>
          <DistanceVisualizer
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
          />
        </section>

        {/* Time Zone Syncing & Overlaps */}
        <section className="dashboard-grid">
          <TimezoneSync
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
          />

          <ChatBox
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
          />
        </section>

        {/* Shared Activity Center */}
        <section>
          <ActivityFinder
            nameA={userNameA}
            nameB={userNameB}
          />
        </section>
      </main>


      {/* Footer */}
      <footer
        style={{
          borderTop: '1px solid var(--border-glass)',
          padding: '24px 0',
          marginTop: 'auto',
          background: 'rgba(0,0,0,0.2)',
          textAlign: 'center',
          fontSize: '13px',
          color: 'var(--text-muted)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <span>Far Away Connection Hub</span>
          <span>•</span>
          <span>Hackathon MVP</span>
          <span>•</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            Made with <Heart size={12} color="var(--secondary)" /> for Far Away Zuup
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
