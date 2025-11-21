import React from 'react'

function SystemRequirements() {
  const requirements = [
    {
      label: 'Operating System',
      value: 'macOS 10.13 (High Sierra) or later'
    },
    {
      label: 'Architecture',
      value: 'Apple Silicon (ARM64) or Intel (x64)'
    },
    {
      label: 'Storage',
      value: 'At least 500 MB free disk space'
    },
    {
      label: 'Memory',
      value: '4 GB RAM minimum (8 GB recommended)'
    }
  ]

  return (
    <section className="section">
      <h2 className="section-title">System Requirements</h2>
      <div className="requirements">
        <div className="requirements-grid">
          {requirements.map((req, index) => (
            <div key={index} className="requirement-item">
              <div className="requirement-icon">✓</div>
              <div className="requirement-text">
                <strong>{req.label}</strong>
                {req.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default SystemRequirements

