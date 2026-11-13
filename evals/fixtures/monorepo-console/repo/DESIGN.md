---
name: Northwind Platform
description: Shared brand system for every Northwind app.
version: alpha
colors:
  primary: '#2f5d50'
  surface: '#ffffff'
  canvas: '#f6f5f1'
  ink: '#1c1b19'
  muted: '#6b6862'
typography:
  heading:
    fontFamily: Fraunces, Georgia, serif
    fontSize: 1.5rem
    fontWeight: 600
  body:
    fontFamily: Public Sans, system-ui, sans-serif
    fontSize: 0.9375rem
    fontWeight: 400
rounded:
  sm: 4px
  md: 8px
spacing:
  unit: 4px
---

## Overview

Northwind builds operations software. Every app shares this brand: Fraunces headings, Public Sans body, and one green primary.

## Colors

Primary `{colors.primary}` marks the single most important action. Surfaces sit on `{colors.canvas}` in `{colors.surface}`. Muted text uses `{colors.muted}`.

## Typography

Fraunces for headings, Public Sans for everything else. Sentence case; no all-caps labels.

## Layout

A 4px spacing unit. Marketing pages are generous; product surfaces may tighten this in their own file.

## Elevation & Depth

Depth comes from a 1px hairline and a surface shift, never from stacked shadows.

## Shapes

4px on inputs and chips, 8px on cards and dialogs.

## Components

Cards use `{colors.surface}`, `{rounded.md}`, and 20px padding.

## Do's and Don'ts

- Do keep one primary action per view.
- Don't introduce a new accent color for a single feature.
- Don't use all-caps labels.
