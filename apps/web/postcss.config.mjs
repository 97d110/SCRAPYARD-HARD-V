import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import tailwindConfig from './tailwind.config.mjs';

/**
 * The Tailwind config object is passed in directly rather than letting the
 * plugin go looking for a `tailwind.config.*` file. Config discovery is relative
 * to the working directory, and the build runs from the repo root — so
 * discovery would find nothing and drop the entire custom palette.
 */
export default {
  plugins: [tailwindcss(tailwindConfig), autoprefixer()],
};
