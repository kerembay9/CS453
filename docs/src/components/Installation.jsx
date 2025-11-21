import React from 'react'

function Installation() {
  const steps = [
    {
      number: 1,
      title: 'Download the DMG File',
      description: "Click the download button above that matches your Mac's architecture. If you're unsure, Apple Silicon Macs (M1, M2, M3) should use the ARM64 version, while Intel-based Macs should use the x64 version."
    },
    {
      number: 2,
      title: 'Open the DMG File',
      description: 'Once the download completes, locate the DMG file in your Downloads folder and double-click to open it. A new window will appear with the Opsidian application.'
    },
    {
      number: 3,
      title: 'Install to Applications',
      description: 'Drag the Opsidian application icon to your Applications folder. This will copy the application to your system for permanent installation.'
    },
    {
      number: 4,
      title: 'Launch and Allow',
      description: 'Open Opsidian from your Applications folder. On first launch, macOS may display a security warning. Go to System Preferences → Security & Privacy and click "Open Anyway" to allow the application to run.'
    }
  ]

  return (
    <section className="section">
      <h2 className="section-title">Installation Instructions</h2>
      <div className="installation">
        <div className="steps">
          {steps.map((step) => (
            <div key={step.number} className="step">
              <div className="step-number">{step.number}</div>
              <div className="step-content">
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default Installation

