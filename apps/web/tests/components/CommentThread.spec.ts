import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'CommentThread.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-3: components/CommentThread.vue exists', () => {
  test('file is present at components/CommentThread.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — accepts projectSlug and ticketRef props
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-3 AC1: CommentThread.vue accepts projectSlug and ticketRef props', () => {
  test('source defines props with defineProps', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('defineProps')
  })

  test('source declares a projectSlug prop', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('projectSlug')
  })

  test('source declares a ticketRef prop', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('ticketRef')
  })

  test('source uses TypeScript typing for props', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasTypedProps =
      source.includes('defineProps<') ||
      source.includes('defineProps({') ||
      source.includes('PropType')
    expect(hasTypedProps).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — comments fetched via useAsyncData and rendered in chronological order
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-3 AC2: comments fetched via useAsyncData and rendered chronologically', () => {
  test('source uses useAsyncData for data fetching', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('useAsyncData')
  })

  test('source uses useApi composable', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('useApi')
  })

  test('source calls $api.get to fetch comments', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('$api.get')
  })

  test('source fetches from /projects/${slug}/tickets/${ref}/comments endpoint', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasFetchEndpoint =
      source.includes('/comments') &&
      (source.includes('/projects/') || source.includes('projects/${') || source.includes('projects/`'))
    expect(hasFetchEndpoint).toBe(true)
  })

  test('source renders comments using v-for', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('v-for')
  })

  test('source renders comment body content', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasBody =
      source.includes('.body') ||
      source.includes('comment.body') ||
      source.includes('c.body')
    expect(hasBody).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — colored type pills per comment type
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-3 AC3: each comment displays a colored type pill', () => {
  test('source references VERIFICATION comment type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('VERIFICATION')
  })

  test('source references FIX_REPORT comment type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('FIX_REPORT')
  })

  test('source references REVIEW comment type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('REVIEW')
  })

  test('source references GENERAL comment type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('GENERAL')
  })

  test('source applies blue styling for VERIFICATION type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasBlue =
      source.includes('blue') ||
      source.includes('bg-blue') ||
      source.includes('text-blue')
    expect(hasBlue).toBe(true)
  })

  test('source applies orange styling for FIX_REPORT type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasOrange =
      source.includes('orange') ||
      source.includes('bg-orange') ||
      source.includes('text-orange')
    expect(hasOrange).toBe(true)
  })

  test('source applies green styling for REVIEW type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasGreen =
      source.includes('green') ||
      source.includes('bg-green') ||
      source.includes('text-green')
    expect(hasGreen).toBe(true)
  })

  test('source applies gray styling for GENERAL type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasGray =
      source.includes('gray') ||
      source.includes('bg-gray') ||
      source.includes('text-gray') ||
      source.includes('muted')
    expect(hasGray).toBe(true)
  })

  test('source uses Badge component or equivalent for type pills', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasPill =
      source.includes('Badge') ||
      source.includes('pill') ||
      source.includes('rounded-full') ||
      source.includes('rounded-md')
    expect(hasPill).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — add-comment form with required body Textarea and type Select
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-3 AC4: add-comment form has a required body Textarea and type Select', () => {
  test('source uses Textarea component for comment body', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('Textarea')
  })

  test('source uses Select component for comment type', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('Select')
  })

  test('source includes GENERAL as a Select option', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('GENERAL')
  })

  test('source includes VERIFICATION as a Select option', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('VERIFICATION')
  })

  test('source includes FIX_REPORT as a Select option', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('FIX_REPORT')
  })

  test('source includes REVIEW as a Select option', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('REVIEW')
  })

  test('source has a submit button for the form', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasSubmit =
      source.includes('type="submit"') ||
      source.includes("type='submit'") ||
      source.includes('@submit') ||
      source.includes('v-on:submit')
    expect(hasSubmit).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — form submits POST to correct endpoint and appends comment reactively
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-3 AC5: form POSTs to correct endpoint and appends comment without full reload', () => {
  test('source calls $api.post to submit a comment', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('$api.post')
  })

  test('source POSTs to the /comments endpoint', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasCommentsPost =
      source.includes('/comments') &&
      source.includes('$api.post')
    expect(hasCommentsPost).toBe(true)
  })

  test('source appends new comment to reactive list without full reload', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasReactiveAppend =
      source.includes('.push(') ||
      source.includes('comments.value') ||
      source.includes('unshift(')
    expect(hasReactiveAppend).toBe(true)
  })

  test('source awaits the POST call before appending', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('await')
  })

  test('source uses a reactive ref or computed for comments list', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasReactiveComments =
      source.includes('ref(') ||
      source.includes('reactive(') ||
      source.includes('computed(')
    expect(hasReactiveComments).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — body field shows validation error if submitted empty
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-3 AC6: body field shows a validation error if submitted empty', () => {
  test('source uses vee-validate or zod for form validation', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasValidation =
      source.includes('vee-validate') ||
      source.includes('useForm') ||
      source.includes('toTypedSchema') ||
      source.includes('z.string') ||
      source.includes('zod') ||
      source.includes('min(1') ||
      source.includes('min(3')
    expect(hasValidation).toBe(true)
  })

  test('source marks body as required in validation schema', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasRequired =
      source.includes('required') ||
      source.includes('.min(1') ||
      source.includes('.min(3') ||
      source.includes('nonempty') ||
      source.includes('z.string()')
    expect(hasRequired).toBe(true)
  })

  test('source uses FormMessage or equivalent to display validation errors', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasErrorDisplay =
      source.includes('FormMessage') ||
      source.includes('errorMessage') ||
      source.includes('error-message') ||
      source.includes('errors.body')
    expect(hasErrorDisplay).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// US-002: Form validation with toTypedSchema
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: Empty body field shows validation error without calling API', () => {
  test('source imports toTypedSchema from @vee-validate/zod', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain("import { toTypedSchema } from '@vee-validate/zod'")
  })

  test('source wraps commentSchema with toTypedSchema', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasToTypedSchema =
      source.includes('toTypedSchema(') &&
      (source.includes('commentSchema') ||
       (source.includes('z.object(') && source.includes('toTypedSchema')))
    expect(hasToTypedSchema).toBe(true)
  })
})

describe('US-002 AC2: Valid body field allows API call with body and type', () => {
  test('commentSchema validates body with z.string().min(1)', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasBodyMin =
      source.includes("body: z.string().min(1") ||
      source.includes("body: z.string().min( 1")
    expect(hasBodyMin).toBe(true)
  })

  test('onSubmit handles form submission and calls $api.post', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasSubmit =
      source.includes('onSubmit') &&
      source.includes('$api.post')
    expect(hasSubmit).toBe(true)
  })
})

describe('US-002 AC3: Invalid type field shows validation error without calling API', () => {
  test('commentSchema validates type as z.enum with correct values', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasTypeEnum =
      source.includes("z.enum(['GENERAL', 'VERIFICATION', 'FIX_REPORT', 'REVIEW'])")
    expect(hasTypeEnum).toBe(true)
  })
})

describe('US-002 AC4: After successful submission, form is reset', () => {
  test('onSubmit calls resetForm() after successful submission', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasResetForm =
      source.includes('resetForm()')
    expect(hasResetForm).toBe(true)
  })

  test('resetForm initialValues set body to empty string and type to GENERAL', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasInitialValues =
      (source.includes("body: ''") || source.includes('body: ""')) &&
      source.includes("type: 'GENERAL'")
    expect(hasInitialValues).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-3: CommentThread.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
