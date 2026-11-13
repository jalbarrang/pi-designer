---
name: Northwind Console
description: Calm, dense analytics console for operations teams.
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
components:
  card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: 20px
---

## Overview

Northwind is an analytics console for operations teams. Interfaces should feel calm and dense: data first, chrome second. One primary action per view, and never two competing ones.

## Colors

Primary `{colors.primary}` marks the single most important action on a screen. Cards sit on `{colors.canvas}` in `{colors.surface}`. Muted text uses `{colors.muted}`.

## Colors

Accent colors are intentionally absent; every highlight is a mix of the ink color.

## Typography

Fraunces for headings, Public Sans for everything else. Sentence case everywhere; no all-caps labels and no letter-spacing tricks.

## Layout

Everything is a multiple of 4px. Cards are separated by 16px of space, never by an extra border or a shadow.

## Elevation & Depth

Depth comes from a 1px hairline and a surface shift. Do not stack shadows to fake elevation.

## Shapes

4px on inputs and chips, 8px on cards and dialogs. Nothing fully rounded.

## Components

Cards use `{colors.surface}`, `{rounded.md}`, and 20px padding, with a hairline border in a 10% mix of the ink color.

## Do's and Don'ts

- Do keep one primary action per view.
- Do reuse the existing `PlanCard` shape for anything card-like.
- Don't introduce a new accent color for a single feature.
- Don't use all-caps labels.
