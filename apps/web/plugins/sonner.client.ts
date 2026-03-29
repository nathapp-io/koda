import * as sonner from 'vue-sonner'
import 'vue-sonner/style.css'

export default defineNuxtPlugin<{ toast: typeof sonner.toast }>(() => {
  return {
    provide: {
      toast: sonner.toast,
    },
  }
})
