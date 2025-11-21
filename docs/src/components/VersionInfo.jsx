import React from 'react'

function VersionInfo() {
  return (
    <div className="version-info">
      <div className="version-badge">Version 1.0.0</div>
      <p style={{ color: 'var(--text-secondary)', marginTop: '12px' }}>
        Latest stable release • Built with Electron and Next.js
      </p>
    </div>
  )
}

export default VersionInfo

