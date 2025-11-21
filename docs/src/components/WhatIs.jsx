import React from 'react'

function WhatIs() {
  return (
    <section className="section">
      <h2 className="section-title">What is Opsidian?</h2>
      <p className="section-subtitle">
        A modern desktop application that combines AI-powered code
        assistance with integrated project management tools
      </p>

      <div className="what-is">
        <p>
          <strong>Opsidian</strong> is a native macOS desktop application
          that provides developers with an all-in-one platform for
          AI-assisted coding, project management, and development workflows.
          Built on Electron, it seamlessly integrates a powerful backend
          server with a modern Next.js frontend, delivering a responsive and
          intuitive user experience.
        </p>
        <p>
          The application runs a local Express backend server and serves a
          static Next.js frontend, all wrapped in a native Electron shell.
          This architecture ensures fast performance, offline capabilities,
          and a familiar desktop application feel while leveraging modern
          web technologies.
        </p>
        <p>
          Whether you're working on individual projects or collaborating
          with teams, Opsidian provides the tools you need to streamline
          your development process and enhance productivity through
          intelligent AI assistance.
        </p>
      </div>
    </section>
  )
}

export default WhatIs

