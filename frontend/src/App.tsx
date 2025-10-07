import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import DashboardPage from './pages/DashboardPage'
import DevModePage from './pages/DevModePage'
import SettingsPage from './pages/SettingsPage'
import CalendarDashboard from './components/CalendarDashboard'

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/mail" replace />} />
      <Route path="/mail" element={<DashboardPage />} />
      <Route path="/calendar" element={<CalendarDashboard />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/dev" element={<DevModePage />} />
      <Route path="*" element={<Navigate to="/mail" replace />} />
    </Routes>
  )
}
