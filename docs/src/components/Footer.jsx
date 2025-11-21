import React from 'react'

function Footer() {
  return (
    <footer>
      <div className="container">
        <p>&copy; {new Date().getFullYear()} Opsidian. All rights reserved.</p>
        <p>Built with Electron • Powered by AI</p>
      </div>
    </footer>
  )
}

export default Footer

