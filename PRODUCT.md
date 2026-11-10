# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Buyers and sellers are equally first-class. Buyers (Indian shoppers) browse and order pre-owned fashion and more, mostly on phones. Sellers sign up, list items, manage stock and fulfil orders. An admin role exists in the codebase.

## Product Purpose
Reloved is a marketplace for pre-owned items, with preloved fashion first, sold by verified Indian sellers. Success is buyers finding and trusting good items, and sellers listing and selling them with little friction.

## Positioning
Curated preloved fashion: the offer is quality-checked fashion, not an open classifieds board. (Confirmed by the user; seller verification is also in the page title.)

## Operating Context
Installable PWA (service worker, manifest) in plain HTML, CSS and JavaScript, no framework. Talks to a Fastify and Postgres (Supabase) API under `/api/v1`, deployed on Vercel. Includes swipe discovery, seller and admin screens, safety, social and showcase modules. Legal pages: terms, privacy, delete-account.

## Capabilities and Constraints
- Platform is web now; a native app is planned later, so keep product logic and content portable.
- Stack stays vanilla HTML/CSS/JS.
- README says selling, orders, returns, admin, online payments and notifications are "not available yet", but `seller.js` and `admin.js` exist; actual status is undecided and should be checked before claiming features.
- `db.js`, `schema.sql`, `security.sql` are legacy prototype files, unused.

## Brand Commitments
Name "Reloved". Tagline from page title: "preloved fashion and more from verified Indian sellers". No other brand constraints confirmed.

## Evidence on Hand
Icons (`icon-192.png`, `icon-512.png`), the existing UI, and legal pages. No testimonials, metrics or seller counts confirmed; do not fabricate them.

## Product Principles
- Trust first: verification, safety and clear item condition come before delight.
- Curation over volume: fewer, better items.
- Serve both sides equally: the seller flow gets the same care as the buyer flow.
- Mobile-first, installable, fast on modest connections.
- Stay portable for a later native app.
