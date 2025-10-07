import React from 'react'
import { NavLink } from 'react-router-dom'
import { useDevMode } from '../devtools'

export default function AppTopNav(): JSX.Element {
  const devMode = useDevMode()
  return (
    <div className="app-top-nav" role="navigation" aria-label="Hauptnavigation">
      <div className="app-top-nav-inner">
        <NavLink to="/mail" className={({ isActive }) => `top-nav-link${isActive ? ' active' : ''}`}>
          E-Mail-Dashboard
        </NavLink>
        <NavLink to="/calendar" className={({ isActive }) => `top-nav-link${isActive ? ' active' : ''}`}>
          Kalenderdashboard
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `top-nav-link${isActive ? ' active' : ''}`}>
          Einstellungen
        </NavLink>
        {devMode && (
          <NavLink to="/dev" className={({ isActive }) => `top-nav-link${isActive ? ' active' : ''}`}>
            Dev-Mode
          </NavLink>
        )}
      </div>
    </div>
  )
}
