<template>
  <div class="space-y-6">
    <div class="text-center">
      <h2 class="text-3xl font-bold tracking-tight">Koda</h2>
      <p class="mt-2 text-sm text-muted-foreground">
        Dev Ticket Tracker
      </p>
    </div>

    <form class="space-y-4" @submit="onSubmit">
      <FormField name="email" v-slot="{ componentField }">
        <FormItem>
          <FormLabel>Email</FormLabel>
          <FormControl>
            <Input
              type="email"
              placeholder="you@example.com"
              v-bind="componentField"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField name="password" v-slot="{ componentField }">
        <FormItem>
          <FormLabel>Password</FormLabel>
          <FormControl>
            <Input
              type="password"
              placeholder="••••••••"
              v-bind="componentField"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <Button type="submit" class="w-full">
        Sign in
      </Button>
    </form>

    <p class="text-center text-sm text-muted-foreground">
      No account?
      <NuxtLink to="/register" class="font-medium text-primary hover:underline">
        Create one
      </NuxtLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { toast } from 'vue-sonner'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form'

definePageMeta({ layout: 'auth' })

const formSchema = toTypedSchema(z.object({
  email: z.string().email(),
  password: z.string().min(8),
}))

const { handleSubmit } = useForm({ validationSchema: formSchema })

const auth = useAuth()

const onSubmit = handleSubmit(async (values) => {
  try {
    await auth.login(values)
    toast.success('Logged in successfully')
  } catch {
    toast.error('Login failed. Please check your credentials.')
  }
})
</script>
