import React from 'react'

function Header() {
  return (
    <header>
      <nav className="container">
        <div className="logo-container">
          <img
            src="./opsidian-desktop-logo.png"
            alt="Opsidian"
            className="logo-img"
          />
          <span className="logo-text">Opsidian</span>
        </div>
      </nav>
    </header>
  )
}

export default Header

