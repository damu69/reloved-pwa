# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Buyers and sellers are equally first-class. Buyers (Indian shoppers) browse and order pre-owned fashion and more, mostly on phones. Sellers sign up, list items, manage stock and fulfil orders. Admins review sellers, listings and reports.

## Product Purpose
Reloved is a thrift marketplace for pre-owned items in India, sold by verified Indian sellers. Clothing is the largest category, alongside bags, shoes, watches, sunglasses, jewellery and some home decor. Success is buyers finding and trusting good items, and sellers listing and selling them with little friction.

## Positioning
A general thrift marketplace for India where every seller is verified (KYC and admin approval) and every listing is reviewed before it goes live. Confirmed by the user: not limited to fashion. The Gender field (Women, Men, Girls, Boys) is a product attribute and filter, not a category.

## Operating Context
Installable PWA (service worker, manifest) in plain HTML, CSS and JavaScript, no framework. Talks to a Fastify and Postgres (Supabase) API under `/api/v1`, deployed on Vercel. Includes swipe discovery, seller and admin screens, safety, social and showcase modules. Legal pages: terms, privacy, delete-account.

## Capabilities and Constraints
- Platform is web now, also shipped as an Android app that bundles the site (Capacitor); a native iOS app is not planned yet. Keep product logic and content portable.
- Stack stays vanilla HTML/CSS/JS (no framework).
- Live: browse, search and filters (including Gender), item pages, cart, checkout through to an unpaid order, seller application with KYC, seller listings, sizes and stock, admin screens (sellers, products, categories, commission, ratings, reports), chat and swipe discovery, seller ratings, safety and reports, Google and Facebook sign-in.
- Not switched on yet: online payments (Razorpay), email and push notifications, payouts. Checkout ends at "order placed, payment not switched on".
- Categories are one flat list of item types (Dresses, Jeans, Sneakers, Watches...). Gender is chosen separately on each product.
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
