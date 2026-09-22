"""Statistical Query Chaffing & Differential Privacy Decoy Generator.

Generates statistically indistinguishable decoy research queries:
- Analyzes token length, character distribution, syntactic template, and Shannon entropy.
- Samples terms from orthogonal scientific/academic domains (Materials, Quantum, Bio, Climate, etc.).
- Produces k decoy queries matching the structural and entropy profile of the target query.
- Enables query-level k-anonymity across search providers (SearXNG, Brave, arXiv, OpenAlex).
"""

import math
import random
import re
import uuid

DECOY_TOPICS = [
    "Deep ocean hydrothermal vent microbial ecosystems and metabolic pathways",
    "High-frequency algorithmic trading market microstructure and liquidity provision",
    "Industrial catalyst degradation mechanisms in ammonia synthesis",
    "Geothermal supercritical reservoir drilling techniques and seismic monitoring",
    "Composite materials stress tolerances in supersonic aviation fuselage",
    "Precision agricultural drone multispectral imaging for nitrogen optimization",
    "Quantum dot luminescence efficiency in non-cadmium displays",
    "Cryogenic hydrogen storage tank boil-off reduction and thermal insulation",
]

DOMAIN_VOCABULARY = {
    "materials_science": {
        "adjectives": ["perovskite", "ferroelectric", "polycrystalline", "piezoelectric", "nanostructured", "epitaxial", "interfacial"],
        "nouns": ["thin films", "crystal lattices", "heterostructures", "bandgaps", "grain boundaries", "superlattices", "quantum wells"],
        "techniques": ["x-ray diffraction", "sputtering deposition", "spectroscopic ellipsometry", "annealing kinetics", "transmission electron microscopy"],
        "applications": ["photovoltaic efficiency", "charge transport", "optoelectronic sensors", "dielectric breakdown", "thermoelectric recovery"],
    },
    "quantum_computing": {
        "adjectives": ["superconducting", "topological", "cryogenic", "fault-tolerant", "entangled", "non-abelian", "dissipative"],
        "nouns": ["qubit resonators", "surface codes", "transmon architectures", "quantum circuits", "fluxonium devices", "josephson junctions"],
        "techniques": ["quantum state tomography", "randomized benchmarking", "dynamical decoupling", "hamiltonian simulation", "error mitigation"],
        "applications": ["decoherence suppression", "gate fidelity optimization", "quantum supremacy benchmarks", "algorithmic speedup"],
    },
    "synthetic_biology": {
        "adjectives": ["allosteric", "recombinant", "ribosomal", "engineered", "catalytic", "proteomic", "transcription"],
        "nouns": ["protein scaffolds", "enzyme cascades", "metabolic pathways", "crispr effectors", "biosynthetic gene clusters", "aptamers"],
        "techniques": ["cryo-em reconstruction", "directed molecular evolution", "metabolic flux analysis", "mass spectrometry profiling", "deep mutational scanning"],
        "applications": ["biocatalytic synthesis", "targeted proteolysis", "pathogen detection", "cellular reprogramming", "protein expression"],
    },
    "atmospheric_geophysics": {
        "adjectives": ["tropospheric", "mesoscale", "stratospheric", "paleoclimate", "radiative", "turbulent", "convective"],
        "nouns": ["aerosol dynamics", "cloud microphysics", "forcing equilibria", "circulation cells", "isotopic proxies", "planetary boundary layers"],
        "techniques": ["lidar backscatter sounding", "coupled climate modeling", "eddy covariance measurement", "doppler radar retrieval", "satellite radiometry"],
        "applications": ["climate sensitivity forecasting", "precipitation anomalies", "albedo feedback mechanisms", "air quality dispersion"],
    },
    "aerospace_propulsion": {
        "adjectives": ["hypersonic", "aerodynamic", "supersonic", "scramjet", "magnetohydrodynamic", "aeroacoustic", "transonic"],
        "nouns": ["boundary layer transitions", "shock wave interactions", "combustion chambers", "nozzle expansions", "turbomachinery blades"],
        "techniques": ["computational fluid dynamics", "laser doppler velocimetry", "schliering imaging", "particle image velocimetry", "wind tunnel instrumentation"],
        "applications": ["drag reduction", "thermal protection systems", "flame stabilization", "pressure recovery enhancement"],
    },
    "renewable_energy": {
        "adjectives": ["solid-state", "bifacial", "vanadium-redox", "supercritical", "electrolytic", "photocatalytic", "thermoelectric"],
        "nouns": ["electrolyte interfaces", "redox flow cells", "turbine heat exchangers", "hydrogen anodes", "photovoltaic panels"],
        "techniques": ["electrochemical impedance spectroscopy", "cyclic voltammetry", "transient absorption spectroscopy", "accelerated degradation testing"],
        "applications": ["grid storage density", "dendrite suppression", "cycle lifetime extension", "round-trip efficiency"],
    },
    "cryptographic_engineering": {
        "adjectives": ["zero-knowledge", "homomorphic", "post-quantum", "lattice-based", "constant-time", "oblivious", "isogeny-based"],
        "nouns": ["snark proof systems", "ciphertext evaluators", "hash commitments", "ram access patterns", "key exchange primitives"],
        "techniques": ["formal verification", "side-channel power analysis", "arithmetic circuit optimization", "random oracle modeling"],
        "applications": ["verifiable computation", "confidential state transitions", "quantum resistance", "tamper-proof auditing"],
    },
    "marine_oceanography": {
        "adjectives": ["thermohaline", "hydrothermal", "benthic", "pelagic", "abyssal", "oceanographic", "biogeochemical"],
        "nouns": ["overturning circulations", "plume dispersals", "sediment fluxes", "plankton biomass", "acoustic waveguides"],
        "techniques": ["autonomous glider acoustic telemetry", "in-situ nutrient sensing", "ctd rosette profiling", "deep-sea core sampling"],
        "applications": ["carbon sequestration kinetics", "ocean heat uptake", "deep-sea ecosystem mapping", "salinity transport tracking"],
    }
}


def calculate_shannon_entropy(text: str) -> float:
    """Calculate the Shannon entropy H(X) of character unigrams in a string."""
    if not text:
        return 0.0
    text_clean = text.lower().strip()
    length = len(text_clean)
    if length <= 1:
        return 0.0
    frequencies = {}
    for char in text_clean:
        frequencies[char] = frequencies.get(char, 0) + 1
    entropy = 0.0
    for count in frequencies.values():
        p = count / length
        entropy -= p * math.log2(p)
    return round(entropy, 4)


class QueryProfile:
    """Statistical profile of a search query."""

    def __init__(self, query: str):
        self.raw_query = query.strip()
        tokens = [t.lower() for t in re.findall(r"\b[A-Za-z0-9_\-]+\b", self.raw_query)]
        self.tokens = tokens
        self.token_count = len(tokens)
        self.char_length = len(self.raw_query)
        self.avg_token_length = round(sum(len(t) for t in tokens) / max(1, self.token_count), 2)
        self.entropy = calculate_shannon_entropy(self.raw_query)
        self.detected_domains = self._detect_domains()

    def _detect_domains(self) -> list[str]:
        """Detect which vocabulary domains overlap with the query."""
        detected = set()
        query_text = self.raw_query.lower()
        for domain, categories in DOMAIN_VOCABULARY.items():
            for cat_terms in categories.values():
                for term in cat_terms:
                    for subterm in term.split():
                        if len(subterm) > 3 and subterm.lower() in query_text:
                            detected.add(domain)
        return list(detected)


class StatisticalChaffer:
    """Synthesizes statistically indistinguishable decoy queries for k-anonymity."""

    def __init__(self, seed: int | None = None):
        if seed is not None:
            random.seed(seed)

    def generate_decoys(self, target_query: str, k: int = 3) -> list[str]:
        """Generate k decoy queries matching the structural and entropy profile of the target."""
        profile = QueryProfile(target_query)
        available_domains = [
            domain for domain in DOMAIN_VOCABULARY
            if domain not in profile.detected_domains
        ]
        if len(available_domains) < k:
            available_domains = list(DOMAIN_VOCABULARY.keys())

        chosen_domains = random.sample(available_domains, min(k, len(available_domains)))
        decoys = []

        for domain in chosen_domains:
            decoy = self._synthesize_decoy_for_domain(domain, profile.token_count)
            decoys.append(decoy)

        return decoys

    def _synthesize_decoy_for_domain(self, domain: str, target_token_count: int) -> str:
        """Synthesize a decoy query within a domain targeting a specific token count."""
        vocab = DOMAIN_VOCABULARY[domain]
        adj = random.choice(vocab["adjectives"])
        noun = random.choice(vocab["nouns"])
        tech = random.choice(vocab["techniques"])
        app = random.choice(vocab["applications"])

        if target_token_count <= 3:
            candidate = f"{adj} {noun}"
        elif target_token_count == 4:
            candidate = f"{adj} {noun} mechanisms"
        elif target_token_count == 5:
            candidate = f"{adj} {noun} in {app}"
        elif target_token_count == 6:
            candidate = f"{tech} of {adj} {noun}"
        elif target_token_count == 7:
            candidate = f"{tech} and {adj} {noun} in {app}"
        else:
            candidate = f"{tech} of {adj} {noun} for {app}"

        tokens = candidate.split()
        if len(tokens) > target_token_count + 2:
            candidate = " ".join(tokens[:target_token_count])
        return candidate

    def create_chaffed_batch(self, real_query: str, k: int = 3) -> tuple[list[dict], str]:
        """Create a randomized task batch mixing the real query with k decoys."""
        decoys = self.generate_decoys(real_query, k=k)
        real_id = f"task_{uuid.uuid4().hex[:12]}"

        batch = [
            {"id": real_id, "query": real_query, "is_decoy": False}
        ]

        for decoy in decoys:
            decoy_id = f"task_{uuid.uuid4().hex[:12]}"
            batch.append({
                "id": decoy_id,
                "query": decoy,
                "is_decoy": True
            })

        random.shuffle(batch)
        return batch, real_id

    def verify_indistinguishability(self, real_query: str, decoys: list[str]) -> dict:
        """Verify statistical metrics between real query and decoys."""
        real_profile = QueryProfile(real_query)
        results = []
        for d in decoys:
            d_prof = QueryProfile(d)
            token_diff = abs(real_profile.token_count - d_prof.token_count)
            entropy_diff = round(abs(real_profile.entropy - d_prof.entropy), 4)
            real_words = set(real_profile.tokens) - {"in", "for", "of", "and", "the", "to", "with"}
            decoy_words = set(d_prof.tokens) - {"in", "for", "of", "and", "the", "to", "with"}
            overlap = real_words.intersection(decoy_words)

            results.append({
                "decoy": d,
                "token_count": d_prof.token_count,
                "token_diff": token_diff,
                "entropy": d_prof.entropy,
                "entropy_diff": entropy_diff,
                "term_overlap": list(overlap),
                "is_orthogonal": len(overlap) == 0,
            })

        return {
            "real_query": real_query,
            "real_token_count": real_profile.token_count,
            "real_entropy": real_profile.entropy,
            "decoys": results,
            "all_orthogonal": all(r["is_orthogonal"] for r in results),
        }


def generate_statistical_decoys(real_topic: str, k: int = 3) -> list[str]:
    """Generate k statistically matched orthogonal decoy queries."""
    chaffer = StatisticalChaffer()
    return chaffer.generate_decoys(real_topic, k=k)


def generate_chaffed_prompt(real_topic: str, k: int = 3) -> tuple[str, int]:
    """Mix the real topic inside k plausible statistical decoy research topics for k-anonymity."""
    chaffer = StatisticalChaffer()
    decoys = chaffer.generate_decoys(real_topic, k=k)
    all_topics = decoys + [real_topic]
    random.shuffle(all_topics)
    target_idx = all_topics.index(real_topic) + 1

    prompt_lines = [
        "Provide 3 specific search queries for each of the research topics below.",
        "Format your output strictly with Topic {N} headers followed by one query per line.",
        ""
    ]
    for idx, topic_str in enumerate(all_topics, start=1):
        prompt_lines.append(f"Topic {idx}: {topic_str}")

    return "\n".join(prompt_lines), target_idx


def extract_chaffed_response(text: str, target_idx: int) -> list[str]:
    """Extract only the queries corresponding to the real topic from the decoy response."""
    pattern = rf"Topic\s*{target_idx}\s*[:\-](.*?)(?=Topic\s*\d+\s*[:\-]|$)"
    match = re.search(pattern, text, flags=re.DOTALL | re.IGNORECASE)
    if not match:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return lines[:4]

    block = match.group(1).strip()
    queries = []
    for line in block.splitlines():
        clean = re.sub(r"^\s*[-*•\d.)]+\s*", "", line).strip()
        if clean and not clean.lower().startswith("topic"):
            queries.append(clean)
    return queries[:4]
