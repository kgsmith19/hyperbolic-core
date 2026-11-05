# Living Document demos

Run `python3 -m http.server 8000` from the repository root and open `http://localhost:8000/demos/living-document/`.

Each demo is standalone HTML. GSAP uses a public CDN and needs connectivity. The observer demo intentionally uses native IntersectionObserver rather than the Scrollama dependency. The CSS demo requires scroll-driven animation browser support for its motion; its content remains accessible otherwise.

These are concept demonstrations, not production-ready experiences or benchmark results.
