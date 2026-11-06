import { createApp } from 'vue'
import App from '@app/App.vue'
// Bundled display font (no runtime CDN request), Latin subset only.
import '@fontsource/fredoka/latin-500.css'
import '@fontsource/fredoka/latin-600.css'
import '@fontsource/fredoka/latin-700.css'
import '@app/styles.css'

createApp(App).mount('#app')
