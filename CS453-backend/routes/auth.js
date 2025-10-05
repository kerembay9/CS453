const express = require('express')
const passport = require('passport')
const router = express.Router()

router.get('/github', passport.authenticate('github', { scope: ['repo', 'user'] }))

router.get('/github/callback', passport.authenticate('github'), (req, res) => {
  res.redirect('http://localhost:3000/admin/dashboard')
})

router.get('/user', (req, res) => res.json(req.user || null))

router.post('/logout', (req, res) => {
  req.logout(() => res.json({ success: true }))
})

module.exports = router