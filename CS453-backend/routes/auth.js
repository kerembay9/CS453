const express = require('express')
const passport = require('passport')
const crypto = require('crypto')
const router = express.Router()

// Generate and store state for CSRF protection
router.get('/github', (req, res, next) => {
  // Generate random state token
  const state = crypto.randomBytes(32).toString('hex')
  // Store in session
  req.session.oauthState = state
  
  passport.authenticate('github', { 
    scope: ['repo', 'user'],
    state: state // Pass state to OAuth flow
  })(req, res, next)
})

// Verify state on callback
router.get('/github/callback', (req, res, next) => {
  // Verify state parameter matches session
  const sessionState = req.session.oauthState
  const callbackState = req.query.state
  
  if (!sessionState || !callbackState || sessionState !== callbackState) {
    // Clear state from session
    delete req.session.oauthState
    return res.status(403).json({ error: 'Invalid state parameter. Possible CSRF attack.' })
  }
  
  // Clear state from session after verification
  delete req.session.oauthState
  
  // Continue with authentication
  passport.authenticate('github', (err, user, info) => {
    if (err) {
      return res.status(500).json({ error: 'Authentication failed', details: err.message })
    }
    if (!user) {
      return res.status(401).json({ error: 'Authentication failed', details: info?.message || 'Unknown error' })
    }
    
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        return res.status(500).json({ error: 'Login failed', details: loginErr.message })
      }
      res.redirect(process.env.FRONTEND_URL || 'http://localhost:3000/admin/dashboard')
    })
  })(req, res, next)
})

router.get('/user', (req, res) => res.json(req.user || null))

router.post('/logout', (req, res) => {
  req.logout(() => res.json({ success: true }))
})

module.exports = router