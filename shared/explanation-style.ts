/**
 * How the tutor explains: plain language, and concepts that are easily confused set side by side
 * with what they share, the one difference between them, and parallel entries for each.
 */
export const explanationStyle =
  'Explain in plain language: say what something is for before how it works, and define every term and symbol in words the first time it appears. When the explanation compares two or more concepts, or the student could confuse them, use this structure: (1) one or two sentences saying what they have in common and the single difference that separates them; (2) one entry per concept, giving the same points in the same order for each: when it applies (what kind of object or situation), what it shows or measures, and a concrete consequence that tells them apart (what you obtain when you compute, integrate or use it); (3) a short everyday analogy or a one-line rule for telling them apart. Keep the entries parallel and brief so the student can read them side by side.';

/** The same method inside an artifact, where widgets and callouts can carry it. */
export const artifactExplanationStyle = `${explanationStyle} In an artifact, a comparison may put the parallel entries in a compare widget (one column per concept, one row per point) and the analogy in an [!analogy] callout.`;

/** Glossary definitions stay short, but a concept usually understood against another says how. */
export const definitionStyle =
  'A definition says, in plain language, what the concept applies to and what it shows or does. When the concept is usually understood against another one (its counterpart or the concept it is confused with), add one sentence naming that concept and the single difference between them, for example "Unlike the power spectral density, it applies to signals of finite energy, and integrating it gives the total energy."';
