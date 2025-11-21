import React from 'react'

function Features() {
  const features = [
    {
      icon: '🤖',
      title: 'AI-Powered Assistance',
      desc: 'Leverage advanced AI models to get intelligent code suggestions, explanations, and automated assistance throughout your development workflow.'
    },
    {
      icon: '⚡',
      title: 'Native Performance',
      desc: 'Built with Electron for native macOS integration, providing smooth performance and seamless system integration.'
    },
    {
      icon: '🔒',
      title: 'Local-First Architecture',
      desc: 'Your data stays on your machine. The application runs a local backend server, ensuring privacy and offline functionality.'
    },
    {
      icon: '🎨',
      title: 'Modern Interface',
      desc: 'Beautiful, responsive UI built with Next.js and modern design principles for an exceptional user experience.'
    },
    {
      icon: '🔧',
      title: 'Project Management',
      desc: 'Integrated tools for managing projects, tracking progress, and organizing your development workflow.'
    },
    {
      icon: '🚀',
      title: 'Easy Installation',
      desc: 'Simple DMG installation process. Just download, drag, and drop to get started in minutes.'
    }
  ]

  return (
    <section className="section">
      <h2 className="section-title">Key Features</h2>
      <p className="section-subtitle">
        Everything you need for modern software development
      </p>

      <div className="features-grid">
        {features.map((feature, index) => (
          <div key={index} className="feature-card">
            <div className="feature-icon">{feature.icon}</div>
            <h3 className="feature-title">{feature.title}</h3>
            <p className="feature-desc">{feature.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

export default Features

