import React from 'react'

function Downloads() {
  const downloads = [
    {
      icon: '🍎',
      title: 'Apple Silicon',
      subtitle: 'Optimized for M-series chips',
      specs: [
        'Apple M1',
        'Apple M2',
        'Apple M3',
        'Apple M4 and newer'
      ],
      file: './Opsidian-1.0.0-arm64.dmg',
      label: 'Download ARM64'
    },
    {
      icon: '💻',
      title: 'Intel Mac',
      subtitle: 'For x86_64 architecture',
      specs: [
        'Intel Core processors',
        'All Intel-based Macs',
        'macOS 10.13 or later'
      ],
      file: './Opsidian-1.0.0.dmg',
      label: 'Download x64'
    }
  ]

  return (
    <section className="section">
      <h2 className="section-title">Download for macOS</h2>
      <p className="section-subtitle">
        Choose the version compatible with your Mac architecture
      </p>

      <div className="downloads-section">
        <div className="downloads-grid">
          {downloads.map((download, index) => (
            <div key={index} className="download-card">
              <div className="arch-icon">{download.icon}</div>
              <h3 className="arch-title">{download.title}</h3>
              <p className="arch-subtitle">{download.subtitle}</p>
              <div className="arch-specs">
                <strong>Compatible with:</strong><br />
                {download.specs.map((spec, i) => (
                  <React.Fragment key={i}>
                    • {spec}<br />
                  </React.Fragment>
                ))}
              </div>
              <a
                href={download.file}
                className="download-btn"
                download
              >
                {download.label}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default Downloads

