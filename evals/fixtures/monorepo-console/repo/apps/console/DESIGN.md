---
name: Northwind Console
description: Dense analytics surface for operations teams; extends the platform brand.
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
    fontSize: 1.375rem
    fontWeight: 600
  body:
    fontFamily: Public Sans, system-ui, sans-serif
    fontSize: 0.875rem
    fontWeight: 400
rounded:
  sm: 2px
  md: 6px
spacing:
  unit: 8px
---

## Overview

The console is denser than the marketing site. Brand colors and typefaces come from the platform `DESIGN.md`; density, radii and table rules are overridden here.

## Colors

Same tokens as the platform file. `{colors.primary}` marks the one primary action per view.

## Typography

Fraunces headings at 1.375rem, Public Sans body at 0.875rem. Nothing smaller than 0.75rem.

## Layout

An 8px spacing unit, not 4px. Cards are separated by 16px; page gutters are 24px.

## Elevation & Depth

Hairline borders only. A surface shift may replace a border, never both.

## Shapes

2px on chips and inputs, 6px on cards and dialogs.

## Components

Tables use 8px cell padding and a hairline row separator. No zebra stripes, no vertical rules. Cards keep the platform padding of 20px with the console radius.

## Do's and Don'ts

- Do reuse the table rules for anything tabular.
- Don't copy the marketing site's 4px grid into the console.
- Don't add zebra stripes.
