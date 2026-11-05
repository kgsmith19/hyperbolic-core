# Experiment 01 · The Living Document

**Status:** planned; implementation and comparisons not yet executed.

## Creative brief
An editorial interactive documentary that changes scenes as the reader scrolls, without looking like a conventional dashboard. Narrative: *From a question to a living system*.

## Five chapters
1. **Question:** oversized editorial title, stark composition, establish curiosity.
2. **Pieces:** ideas enter a restrained diagram, one at a time.
3. **Connections:** lines form, nodes reorganize to expose relationships.
4. **Transformation:** diagram becomes a timeline, then a decision map.
5. **Resolution:** reader explores the final map with accessible controls and a concise takeaway.

## Three approaches
A. GSAP + ScrollTrigger + SVG (cinematic baseline).
B. Scrollama + SVG/D3 (lightweight narrative baseline).
C. Native CSS scroll-driven animation + progressive enhancement (minimal-dependency baseline).

## Evaluation rubric (1–5 each)
Editorial quality; clarity; scroll responsiveness; touch experience; reduced-motion support; keyboard usability; implementation complexity; runtime performance; maintainability. Record actual measurements and screenshots before ranking.

## Acceptance criteria
- Works on mobile and desktop, including keyboard and touch.
- Text remains readable while scenes transform.
- Reduced-motion mode presents all information without essential animation.
- No scroll trapping or forced smooth scrolling.
- Playwright screenshots and accessibility checks are documented.
- Assets and dependencies have reviewed licenses.

## Next steps
Storyboard three key frames per chapter; implement A/B/C on separate routes; collect screenshots and measurements; choose a default stack based on results.
