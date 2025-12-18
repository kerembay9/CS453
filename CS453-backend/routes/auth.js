const express = require('express')
const passport = require('passport')
const crypto = require('crypto')
const router = express.Router()

// In-memory store for OAuth state (as fallback for Electron compatibility)
// Maps state -> timestamp, expires after 10 minutes
const oauthStateStore = new Map()
const STATE_EXPIRY = 10 * 60 * 1000 // 10 minutes

// Clean up expired states periodically
setInterval(() => {
  const now = Date.now()
  for (const [state, timestamp] of oauthStateStore.entries()) {
    if (now - timestamp > STATE_EXPIRY) {
      oauthStateStore.delete(state)
    }
  }
}, 5 * 60 * 1000) // Clean every 5 minutes

// Generate and store state for CSRF protection
router.get('/github', (req, res, next) => {
  // Generate random state token
  const state = crypto.randomBytes(32).toString('hex')
  
  // Store in both session (for browser) and in-memory store (for Electron fallback)
  req.session.oauthState = state
  oauthStateStore.set(state, Date.now())
  
  // Explicitly save session before redirecting to GitHub
  req.session.save((err) => {
    if (err) {
      console.error('Error saving session:', err)
      return res.status(500).json({ error: 'Failed to initialize session' })
    }
    
    passport.authenticate('github', { 
      scope: ['repo', 'user'],
      state: state // Pass state to OAuth flow
    })(req, res, next)
  })
})

// Verify state on callback
router.get('/github/callback', (req, res, next) => {
  // Verify state parameter matches session OR in-memory store (Electron fallback)
  const sessionState = req.session?.oauthState
  const callbackState = req.query.state
  const memoryState = callbackState ? oauthStateStore.has(callbackState) : false
  
  // Debug logging
  console.log('OAuth callback - Session state:', sessionState ? 'exists' : 'missing')
  console.log('OAuth callback - Memory state:', memoryState ? 'exists' : 'missing')
  console.log('OAuth callback - Callback state:', callbackState ? 'exists' : 'missing')
  console.log('OAuth callback - Session ID:', req.sessionID)
  
  // Check if state is valid (either in session or in-memory store)
  const isValidState = callbackState && (
    (sessionState && sessionState === callbackState) || 
    memoryState
  )
  
  if (!isValidState) {
    // Clear state from both stores
    if (sessionState) delete req.session.oauthState
    if (callbackState) oauthStateStore.delete(callbackState)
    console.error('State mismatch - Session:', sessionState, 'Memory:', memoryState, 'Callback:', callbackState)
    return res.status(403).json({ 
      error: 'Invalid state parameter. Possible CSRF attack.',
      debug: {
        hasSessionState: !!sessionState,
        hasMemoryState: memoryState,
        hasCallbackState: !!callbackState,
        sessionId: req.sessionID
      }
    })
  }
  
  // Clean up: remove from both stores after validation
  if (sessionState) delete req.session.oauthState
  if (callbackState) oauthStateStore.delete(callbackState)
  
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