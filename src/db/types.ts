export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admin_companies: {
        Row: {
          added_at: string
          added_by: string | null
          admin_email: string
          company_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          admin_email: string
          company_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          admin_email?: string
          company_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_companies_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_users: {
        Row: {
          added_at: string
          added_by: string | null
          can_countersign: boolean
          email: string
          name: string | null
          role: string
          user_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          can_countersign?: boolean
          email: string
          name?: string | null
          role?: string
          user_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          can_countersign?: boolean
          email?: string
          name?: string | null
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      agreement_templates: {
        Row: {
          body: string
          kind: Database["public"]["Enums"]["agreement_kind"]
          title: string
          updated_at: string
          updated_by: string | null
          version: string
        }
        Insert: {
          body?: string
          kind: Database["public"]["Enums"]["agreement_kind"]
          title: string
          updated_at?: string
          updated_by?: string | null
          version?: string
        }
        Update: {
          body?: string
          kind?: Database["public"]["Enums"]["agreement_kind"]
          title?: string
          updated_at?: string
          updated_by?: string | null
          version?: string
        }
        Relationships: []
      }
      announcements: {
        Row: {
          active: boolean
          author: string | null
          body: string | null
          id: string
          published_at: string
          title: string
        }
        Insert: {
          active?: boolean
          author?: string | null
          body?: string | null
          id?: string
          published_at?: string
          title: string
        }
        Update: {
          active?: boolean
          author?: string | null
          body?: string | null
          id?: string
          published_at?: string
          title?: string
        }
        Relationships: []
      }
      api_tokens: {
        Row: {
          access_expires_at: string | null
          access_token: string | null
          provider: string
          refresh_token: string
          updated_at: string
        }
        Insert: {
          access_expires_at?: string | null
          access_token?: string | null
          provider: string
          refresh_token: string
          updated_at?: string
        }
        Update: {
          access_expires_at?: string | null
          access_token?: string | null
          provider?: string
          refresh_token?: string
          updated_at?: string
        }
        Relationships: []
      }
      app_secrets: {
        Row: {
          created_at: string
          key: string
          value: string
        }
        Insert: {
          created_at?: string
          key: string
          value: string
        }
        Update: {
          created_at?: string
          key?: string
          value?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor: string | null
          company_id: string | null
          created_at: string
          detail: Json | null
          entity: string | null
          id: string
        }
        Insert: {
          action: string
          actor?: string | null
          company_id?: string | null
          created_at?: string
          detail?: Json | null
          entity?: string | null
          id?: string
        }
        Update: {
          action?: string
          actor?: string | null
          company_id?: string | null
          created_at?: string
          detail?: Json | null
          entity?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          address: string | null
          api_payouts_enabled: boolean
          contacts: Json
          created_at: string
          hubstaff_org_id: number | null
          id: string
          kind: string
          name: string
          phone: string | null
          status: Database["public"]["Enums"]["company_status"]
          tax_id: string | null
          website: string | null
        }
        Insert: {
          address?: string | null
          api_payouts_enabled?: boolean
          contacts?: Json
          created_at?: string
          hubstaff_org_id?: number | null
          id?: string
          kind?: string
          name: string
          phone?: string | null
          status?: Database["public"]["Enums"]["company_status"]
          tax_id?: string | null
          website?: string | null
        }
        Update: {
          address?: string | null
          api_payouts_enabled?: boolean
          contacts?: Json
          created_at?: string
          hubstaff_org_id?: number | null
          id?: string
          kind?: string
          name?: string
          phone?: string | null
          status?: Database["public"]["Enums"]["company_status"]
          tax_id?: string | null
          website?: string | null
        }
        Relationships: []
      }
      contractor_logins: {
        Row: {
          auth_user_id: string | null
          created_at: string
          email: string | null
          last_login_at: string | null
          status: string
          worker_id: string
        }
        Insert: {
          auth_user_id?: string | null
          created_at?: string
          email?: string | null
          last_login_at?: string | null
          status?: string
          worker_id: string
        }
        Update: {
          auth_user_id?: string | null
          created_at?: string
          email?: string | null
          last_login_at?: string | null
          status?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contractor_logins_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: true
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      coverage_targets: {
        Row: {
          company_id: string | null
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          id: string
          note: string | null
          period_kind: string
          target_hours: number | null
          target_sessions: number | null
          worker_id: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          created_by?: string | null
          effective_from: string
          effective_to?: string | null
          id?: string
          note?: string | null
          period_kind?: string
          target_hours?: number | null
          target_sessions?: number | null
          worker_id: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          note?: string | null
          period_kind?: string
          target_hours?: number | null
          target_sessions?: number | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coverage_targets_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coverage_targets_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          company_id: string | null
          created_at: string
          defer_until: string | null
          expires_on: string | null
          file_size_bytes: number | null
          id: string
          issued_on: string | null
          kind: Database["public"]["Enums"]["document_kind"]
          mime_type: string | null
          review_reason: string | null
          review_status: Database["public"]["Enums"]["review_status"]
          reviewed_at: string | null
          reviewed_by: string | null
          side: string | null
          signed_on: string | null
          storage_path: string | null
          title: string | null
          worker_id: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          defer_until?: string | null
          expires_on?: string | null
          file_size_bytes?: number | null
          id?: string
          issued_on?: string | null
          kind: Database["public"]["Enums"]["document_kind"]
          mime_type?: string | null
          review_reason?: string | null
          review_status?: Database["public"]["Enums"]["review_status"]
          reviewed_at?: string | null
          reviewed_by?: string | null
          side?: string | null
          signed_on?: string | null
          storage_path?: string | null
          title?: string | null
          worker_id: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          defer_until?: string | null
          expires_on?: string | null
          file_size_bytes?: number | null
          id?: string
          issued_on?: string | null
          kind?: Database["public"]["Enums"]["document_kind"]
          mime_type?: string | null
          review_reason?: string | null
          review_status?: Database["public"]["Enums"]["review_status"]
          reviewed_at?: string | null
          reviewed_by?: string | null
          side?: string | null
          signed_on?: string | null
          storage_path?: string | null
          title?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      hubstaff_projects: {
        Row: {
          company_id: string
          created_at: string
          hubstaff_project_id: number
          name: string | null
          org_id: number | null
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          hubstaff_project_id: number
          name?: string | null
          org_id?: number | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          hubstaff_project_id?: number
          name?: string | null
          org_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hubstaff_projects_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_lines: {
        Row: {
          amount_usd: number
          bill_rate_usd: number
          id: string
          invoice_id: string
          kind: string
          position: string | null
          session_rate_usd: number | null
          sessions_count: number | null
          worked_hours: number
          worker_id: string | null
          worker_name: string | null
        }
        Insert: {
          amount_usd?: number
          bill_rate_usd?: number
          id?: string
          invoice_id: string
          kind?: string
          position?: string | null
          session_rate_usd?: number | null
          sessions_count?: number | null
          worked_hours?: number
          worker_id?: string | null
          worker_name?: string | null
        }
        Update: {
          amount_usd?: number
          bill_rate_usd?: number
          id?: string
          invoice_id?: string
          kind?: string
          position?: string | null
          session_rate_usd?: number | null
          sessions_count?: number | null
          worked_hours?: number
          worker_id?: string | null
          worker_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_received_usd: number | null
          company_id: string
          created_at: string
          created_by: string | null
          currency: string
          id: string
          invoice_no: string | null
          markup_pct: number
          notes: string | null
          pay_date: string | null
          payment_ref: string | null
          period_end: string
          period_start: string
          received_on: string | null
          status: string
          subtotal_usd: number
          total_usd: number
        }
        Insert: {
          amount_received_usd?: number | null
          company_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          invoice_no?: string | null
          markup_pct?: number
          notes?: string | null
          pay_date?: string | null
          payment_ref?: string | null
          period_end: string
          period_start: string
          received_on?: string | null
          status?: string
          subtotal_usd?: number
          total_usd?: number
        }
        Update: {
          amount_received_usd?: number | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          invoice_no?: string | null
          markup_pct?: number
          notes?: string | null
          pay_date?: string | null
          payment_ref?: string | null
          period_end?: string
          period_start?: string
          received_on?: string | null
          status?: string
          subtotal_usd?: number
          total_usd?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      mood_checkins: {
        Row: {
          created_at: string
          id: string
          kind: string | null
          mood: number | null
          note: string | null
          worker_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string | null
          mood?: number | null
          note?: string | null
          worker_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string | null
          mood?: number | null
          note?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mood_checkins_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_agreements: {
        Row: {
          addendum_text: string | null
          addendum_type: string | null
          agreement_kind: Database["public"]["Enums"]["agreement_kind"]
          countersign_data: string | null
          countersign_ip: string | null
          countersign_method: string | null
          countersigned_at: string | null
          countersigned_by: string | null
          countersigned_name: string | null
          countersigner_name: string | null
          countersigner_user_id: string | null
          f_company_name: string | null
          f_employment_type: string | null
          f_hours_per_week: number | null
          f_position: string | null
          f_rate: string | null
          f_schedule: string | null
          f_start_date: string | null
          prepared_at: string | null
          prepared_by: string | null
          updated_at: string
          worker_id: string
        }
        Insert: {
          addendum_text?: string | null
          addendum_type?: string | null
          agreement_kind: Database["public"]["Enums"]["agreement_kind"]
          countersign_data?: string | null
          countersign_ip?: string | null
          countersign_method?: string | null
          countersigned_at?: string | null
          countersigned_by?: string | null
          countersigned_name?: string | null
          countersigner_name?: string | null
          countersigner_user_id?: string | null
          f_company_name?: string | null
          f_employment_type?: string | null
          f_hours_per_week?: number | null
          f_position?: string | null
          f_rate?: string | null
          f_schedule?: string | null
          f_start_date?: string | null
          prepared_at?: string | null
          prepared_by?: string | null
          updated_at?: string
          worker_id: string
        }
        Update: {
          addendum_text?: string | null
          addendum_type?: string | null
          agreement_kind?: Database["public"]["Enums"]["agreement_kind"]
          countersign_data?: string | null
          countersign_ip?: string | null
          countersign_method?: string | null
          countersigned_at?: string | null
          countersigned_by?: string | null
          countersigned_name?: string | null
          countersigner_name?: string | null
          countersigner_user_id?: string | null
          f_company_name?: string | null
          f_employment_type?: string | null
          f_hours_per_week?: number | null
          f_position?: string | null
          f_rate?: string | null
          f_schedule?: string | null
          f_start_date?: string | null
          prepared_at?: string | null
          prepared_by?: string | null
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_agreements_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_progress: {
        Row: {
          completed_at: string | null
          current_stage: Database["public"]["Enums"]["onboarding_stage"]
          extra_documents: Json
          name_mismatch_flag: boolean
          stage1_complete: boolean
          stage1_last_kind: Database["public"]["Enums"]["agreement_kind"] | null
          stage2_complete: boolean
          stage2_last_tab: string | null
          stage3_complete: boolean
          stalled: boolean
          started_at: string
          updated_at: string
          worker_id: string
        }
        Insert: {
          completed_at?: string | null
          current_stage?: Database["public"]["Enums"]["onboarding_stage"]
          extra_documents?: Json
          name_mismatch_flag?: boolean
          stage1_complete?: boolean
          stage1_last_kind?:
            | Database["public"]["Enums"]["agreement_kind"]
            | null
          stage2_complete?: boolean
          stage2_last_tab?: string | null
          stage3_complete?: boolean
          stalled?: boolean
          started_at?: string
          updated_at?: string
          worker_id: string
        }
        Update: {
          completed_at?: string | null
          current_stage?: Database["public"]["Enums"]["onboarding_stage"]
          extra_documents?: Json
          name_mismatch_flag?: boolean
          stage1_complete?: boolean
          stage1_last_kind?:
            | Database["public"]["Enums"]["agreement_kind"]
            | null
          stage2_complete?: boolean
          stage2_last_tab?: string | null
          stage3_complete?: boolean
          stalled?: boolean
          started_at?: string
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_progress_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: true
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_reminders: {
        Row: {
          channel: string | null
          id: string
          reminder_day: number
          sent_at: string
          stage_at_send: Database["public"]["Enums"]["onboarding_stage"]
          worker_id: string
        }
        Insert: {
          channel?: string | null
          id?: string
          reminder_day: number
          sent_at?: string
          stage_at_send: Database["public"]["Enums"]["onboarding_stage"]
          worker_id: string
        }
        Update: {
          channel?: string | null
          id?: string
          reminder_day?: number
          sent_at?: string
          stage_at_send?: Database["public"]["Enums"]["onboarding_stage"]
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_reminders_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_signatures: {
        Row: {
          agreement_kind: Database["public"]["Enums"]["agreement_kind"]
          created_at: string
          device_fingerprint: string | null
          doc_sha256: string | null
          doc_version: string
          id: string
          ip_address: unknown
          scrolled_to_end: boolean
          signature_data: string | null
          signature_method: Database["public"]["Enums"]["signature_method"]
          signed_at: string
          signed_date: string | null
          signed_legal_name: string
          status: Database["public"]["Enums"]["signature_status"]
          user_agent: string | null
          worker_id: string
        }
        Insert: {
          agreement_kind: Database["public"]["Enums"]["agreement_kind"]
          created_at?: string
          device_fingerprint?: string | null
          doc_sha256?: string | null
          doc_version: string
          id?: string
          ip_address?: unknown
          scrolled_to_end?: boolean
          signature_data?: string | null
          signature_method: Database["public"]["Enums"]["signature_method"]
          signed_at?: string
          signed_date?: string | null
          signed_legal_name: string
          status?: Database["public"]["Enums"]["signature_status"]
          user_agent?: string | null
          worker_id: string
        }
        Update: {
          agreement_kind?: Database["public"]["Enums"]["agreement_kind"]
          created_at?: string
          device_fingerprint?: string | null
          doc_sha256?: string | null
          doc_version?: string
          id?: string
          ip_address?: unknown
          scrolled_to_end?: boolean
          signature_data?: string | null
          signature_method?: Database["public"]["Enums"]["signature_method"]
          signed_at?: string
          signed_date?: string | null
          signed_legal_name?: string
          status?: Database["public"]["Enums"]["signature_status"]
          user_agent?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_signatures_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      pay_periods: {
        Row: {
          company_id: string
          created_at: string
          expected_hours_ft: number
          expected_hours_pt: number
          id: string
          locked_at: string | null
          pay_date: string | null
          period_end: string
          period_start: string
          state: Database["public"]["Enums"]["pay_period_state"]
        }
        Insert: {
          company_id: string
          created_at?: string
          expected_hours_ft?: number
          expected_hours_pt?: number
          id?: string
          locked_at?: string | null
          pay_date?: string | null
          period_end: string
          period_start: string
          state?: Database["public"]["Enums"]["pay_period_state"]
        }
        Update: {
          company_id?: string
          created_at?: string
          expected_hours_ft?: number
          expected_hours_pt?: number
          id?: string
          locked_at?: string | null
          pay_date?: string | null
          period_end?: string
          period_start?: string
          state?: Database["public"]["Enums"]["pay_period_state"]
        }
        Relationships: [
          {
            foreignKeyName: "pay_periods_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          bonus_php: number
          company_id: string
          contract: string | null
          created_at: string
          deduction_php: number
          expected_hours: number | null
          fund_error: string | null
          funded_at: string | null
          funded_by: string | null
          fx_rate: number | null
          gross_php: number
          health_allowance_php: number
          id: string
          misc_items: Json
          net_php: number
          note: string | null
          original_net_php: number | null
          paid_at: string | null
          pay_basis: string | null
          pay_period_id: string
          payout_amount: number | null
          payout_currency: string
          payout_method: Database["public"]["Enums"]["payout_method"] | null
          pdd_lunch_php: number
          performance_ratio: number | null
          rate_php: number | null
          status: Database["public"]["Enums"]["payment_status"]
          thirteenth_month_php: number
          units: number | null
          wise_dates: Json | null
          wise_locked_at: string | null
          wise_transfer_id: string | null
          worked_hours: number | null
          worker_id: string
        }
        Insert: {
          bonus_php?: number
          company_id: string
          contract?: string | null
          created_at?: string
          deduction_php?: number
          expected_hours?: number | null
          fund_error?: string | null
          funded_at?: string | null
          funded_by?: string | null
          fx_rate?: number | null
          gross_php?: number
          health_allowance_php?: number
          id?: string
          misc_items?: Json
          net_php?: number
          note?: string | null
          original_net_php?: number | null
          paid_at?: string | null
          pay_basis?: string | null
          pay_period_id: string
          payout_amount?: number | null
          payout_currency?: string
          payout_method?: Database["public"]["Enums"]["payout_method"] | null
          pdd_lunch_php?: number
          performance_ratio?: number | null
          rate_php?: number | null
          status?: Database["public"]["Enums"]["payment_status"]
          thirteenth_month_php?: number
          units?: number | null
          wise_dates?: Json | null
          wise_locked_at?: string | null
          wise_transfer_id?: string | null
          worked_hours?: number | null
          worker_id: string
        }
        Update: {
          bonus_php?: number
          company_id?: string
          contract?: string | null
          created_at?: string
          deduction_php?: number
          expected_hours?: number | null
          fund_error?: string | null
          funded_at?: string | null
          funded_by?: string | null
          fx_rate?: number | null
          gross_php?: number
          health_allowance_php?: number
          id?: string
          misc_items?: Json
          net_php?: number
          note?: string | null
          original_net_php?: number | null
          paid_at?: string | null
          pay_basis?: string | null
          pay_period_id?: string
          payout_amount?: number | null
          payout_currency?: string
          payout_method?: Database["public"]["Enums"]["payout_method"] | null
          pdd_lunch_php?: number
          performance_ratio?: number | null
          rate_php?: number | null
          status?: Database["public"]["Enums"]["payment_status"]
          thirteenth_month_php?: number
          units?: number | null
          wise_dates?: Json | null
          wise_locked_at?: string | null
          wise_transfer_id?: string | null
          worked_hours?: number | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_pay_period_id_fkey"
            columns: ["pay_period_id"]
            isOneToOne: false
            referencedRelation: "pay_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_admins: {
        Row: {
          added_at: string
          added_by: string | null
          email: string
          role: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          email: string
          role?: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          email?: string
          role?: string
        }
        Relationships: []
      }
      portal_notifications: {
        Row: {
          body: string | null
          created_at: string
          dismissed_at: string | null
          id: string
          kind: Database["public"]["Enums"]["portal_notification_kind"]
          title: string
          worker_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          dismissed_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["portal_notification_kind"]
          title: string
          worker_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          dismissed_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["portal_notification_kind"]
          title?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portal_notifications_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_settings: {
        Row: {
          editable_fields: Json
          id: number
          onboarding_config: Json
          updated_at: string
        }
        Insert: {
          editable_fields?: Json
          id?: number
          onboarding_config?: Json
          updated_at?: string
        }
        Update: {
          editable_fields?: Json
          id?: number
          onboarding_config?: Json
          updated_at?: string
        }
        Relationships: []
      }
      rates: {
        Row: {
          amount_php: number
          company_id: string
          created_at: string
          effective_end: string | null
          effective_start: string
          id: string
          note: string | null
          period_basis: string
          worker_id: string
        }
        Insert: {
          amount_php: number
          company_id: string
          created_at?: string
          effective_end?: string | null
          effective_start: string
          id?: string
          note?: string | null
          period_basis?: string
          worker_id: string
        }
        Update: {
          amount_php?: number
          company_id?: string
          created_at?: string
          effective_end?: string | null
          effective_start?: string
          id?: string
          note?: string | null
          period_basis?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rates_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      service_sessions: {
        Row: {
          approval: Database["public"]["Enums"]["approval_status"]
          approved_at: string | null
          approved_by: string | null
          case_ref: string | null
          child_initials: string | null
          company_id: string
          created_at: string
          created_by: string | null
          eiid: string | null
          external_ref: string | null
          id: string
          import_batch_id: string | null
          notes: string | null
          session_date: string
          session_type: string | null
          units: number
          worker_id: string | null
        }
        Insert: {
          approval?: Database["public"]["Enums"]["approval_status"]
          approved_at?: string | null
          approved_by?: string | null
          case_ref?: string | null
          child_initials?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          eiid?: string | null
          external_ref?: string | null
          id?: string
          import_batch_id?: string | null
          notes?: string | null
          session_date: string
          session_type?: string | null
          units?: number
          worker_id?: string | null
        }
        Update: {
          approval?: Database["public"]["Enums"]["approval_status"]
          approved_at?: string | null
          approved_by?: string | null
          case_ref?: string | null
          child_initials?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          eiid?: string | null
          external_ref?: string | null
          id?: string
          import_batch_id?: string | null
          notes?: string | null
          session_date?: string
          session_type?: string | null
          units?: number
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_sessions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_sessions_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          activity_pct: number | null
          approval: Database["public"]["Enums"]["approval_status"]
          approved_at: string | null
          approved_by: string | null
          company_id: string
          created_at: string
          id: string
          import_batch_id: string | null
          pay_period_id: string | null
          project: string | null
          pto_seconds: number
          source_name: string
          tracked_seconds: number
          work_date: string
          worker_id: string | null
        }
        Insert: {
          activity_pct?: number | null
          approval?: Database["public"]["Enums"]["approval_status"]
          approved_at?: string | null
          approved_by?: string | null
          company_id: string
          created_at?: string
          id?: string
          import_batch_id?: string | null
          pay_period_id?: string | null
          project?: string | null
          pto_seconds?: number
          source_name: string
          tracked_seconds?: number
          work_date: string
          worker_id?: string | null
        }
        Update: {
          activity_pct?: number | null
          approval?: Database["public"]["Enums"]["approval_status"]
          approved_at?: string | null
          approved_by?: string | null
          company_id?: string
          created_at?: string
          id?: string
          import_batch_id?: string | null
          pay_period_id?: string | null
          project?: string | null
          pto_seconds?: number
          source_name?: string
          tracked_seconds?: number
          work_date?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "time_entries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_pay_period_id_fkey"
            columns: ["pay_period_id"]
            isOneToOne: false
            referencedRelation: "pay_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_companies: {
        Row: {
          bill_rate_usd: number | null
          company_id: string
          contract: Database["public"]["Enums"]["contract_type"]
          ended_on: string | null
          hubstaff_name: string | null
          hubstaff_user_id: number | null
          id: string
          pay_basis: string | null
          role: string | null
          session_rate_usd: number | null
          started_on: string | null
          status: Database["public"]["Enums"]["worker_status"]
          weekly_hours: number | null
          worker_id: string
        }
        Insert: {
          bill_rate_usd?: number | null
          company_id: string
          contract?: Database["public"]["Enums"]["contract_type"]
          ended_on?: string | null
          hubstaff_name?: string | null
          hubstaff_user_id?: number | null
          id?: string
          pay_basis?: string | null
          role?: string | null
          session_rate_usd?: number | null
          started_on?: string | null
          status?: Database["public"]["Enums"]["worker_status"]
          weekly_hours?: number | null
          worker_id: string
        }
        Update: {
          bill_rate_usd?: number | null
          company_id?: string
          contract?: Database["public"]["Enums"]["contract_type"]
          ended_on?: string | null
          hubstaff_name?: string | null
          hubstaff_user_id?: number | null
          id?: string
          pay_basis?: string | null
          role?: string | null
          session_rate_usd?: number | null
          started_on?: string | null
          status?: Database["public"]["Enums"]["worker_status"]
          weekly_hours?: number | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_companies_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_companies_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_tools: {
        Row: {
          acked_at: string | null
          enc: string | null
          popup_pending: boolean
          provisioned_at: string | null
          requested: Json
          revealed_at: string | null
          updated_at: string
          worker_id: string
        }
        Insert: {
          acked_at?: string | null
          enc?: string | null
          popup_pending?: boolean
          provisioned_at?: string | null
          requested?: Json
          revealed_at?: string | null
          updated_at?: string
          worker_id: string
        }
        Update: {
          acked_at?: string | null
          enc?: string | null
          popup_pending?: boolean
          provisioned_at?: string | null
          requested?: Json
          revealed_at?: string | null
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_tools_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: true
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      workers: {
        Row: {
          address_landmark: string | null
          course: string | null
          created_at: string
          created_by: string | null
          date_of_birth: string | null
          education_level: string | null
          email: string | null
          emergency_mobile: string | null
          emergency_name: string | null
          emergency_relationship: string | null
          first_name: string
          gcash: string | null
          health_allowance_eligible: boolean
          hire_date: string | null
          id: string
          last_name: string
          marital_status: string | null
          match_key: string | null
          middle_name: string | null
          mobile: string | null
          paymaya: string | null
          payout_account: Json | null
          payout_method: Database["public"]["Enums"]["payout_method"] | null
          paypal: string | null
          permanent_address: string | null
          ph_address: string | null
          photo_url: string | null
          postal_code: string | null
          profile_extras: Json
          school: string | null
          shift_end: string | null
          shift_start: string | null
          status: Database["public"]["Enums"]["worker_status"]
          thirteenth_month_eligible: boolean
          wise_recipient_id: number | null
          wise_recipient_uuid: string | null
          wise_recipients: Json | null
          wise_tag: string | null
          work_email: string | null
          work_extension: string | null
          work_number: string | null
          year_graduated: string | null
        }
        Insert: {
          address_landmark?: string | null
          course?: string | null
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          education_level?: string | null
          email?: string | null
          emergency_mobile?: string | null
          emergency_name?: string | null
          emergency_relationship?: string | null
          first_name: string
          gcash?: string | null
          health_allowance_eligible?: boolean
          hire_date?: string | null
          id?: string
          last_name: string
          marital_status?: string | null
          match_key?: string | null
          middle_name?: string | null
          mobile?: string | null
          paymaya?: string | null
          payout_account?: Json | null
          payout_method?: Database["public"]["Enums"]["payout_method"] | null
          paypal?: string | null
          permanent_address?: string | null
          ph_address?: string | null
          photo_url?: string | null
          postal_code?: string | null
          profile_extras?: Json
          school?: string | null
          shift_end?: string | null
          shift_start?: string | null
          status?: Database["public"]["Enums"]["worker_status"]
          thirteenth_month_eligible?: boolean
          wise_recipient_id?: number | null
          wise_recipient_uuid?: string | null
          wise_recipients?: Json | null
          wise_tag?: string | null
          work_email?: string | null
          work_extension?: string | null
          work_number?: string | null
          year_graduated?: string | null
        }
        Update: {
          address_landmark?: string | null
          course?: string | null
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          education_level?: string | null
          email?: string | null
          emergency_mobile?: string | null
          emergency_name?: string | null
          emergency_relationship?: string | null
          first_name?: string
          gcash?: string | null
          health_allowance_eligible?: boolean
          hire_date?: string | null
          id?: string
          last_name?: string
          marital_status?: string | null
          match_key?: string | null
          middle_name?: string | null
          mobile?: string | null
          paymaya?: string | null
          payout_account?: Json | null
          payout_method?: Database["public"]["Enums"]["payout_method"] | null
          paypal?: string | null
          permanent_address?: string | null
          ph_address?: string | null
          photo_url?: string | null
          postal_code?: string | null
          profile_extras?: Json
          school?: string | null
          shift_end?: string | null
          shift_start?: string | null
          status?: Database["public"]["Enums"]["worker_status"]
          thirteenth_month_eligible?: boolean
          wise_recipient_id?: number | null
          wise_recipient_uuid?: string | null
          wise_recipients?: Json | null
          wise_tag?: string | null
          work_email?: string | null
          work_extension?: string | null
          work_number?: string | null
          year_graduated?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      v_payouts_by_period: {
        Row: {
          company_id: string | null
          company_name: string | null
          contractor_count: number | null
          payout_currency: string | null
          period_end: string | null
          period_start: string | null
          total_net_php: number | null
          total_payout: number | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      ack_my_tools: { Args: never; Returns: undefined }
      admin_can_see_worker: { Args: { wid: string }; Returns: boolean }
      admin_lookup_auth_user: { Args: { p_email: string }; Returns: string }
      allocate_invoice_no: { Args: { p_year: number }; Returns: string }
      get_my_tools: { Args: never; Returns: Json }
      get_tools_status: { Args: { p_worker_id: string }; Returns: Json }
      is_admin: { Args: never; Returns: boolean }
      is_company_admin: { Args: { cid: string }; Returns: boolean }
      is_onboarded: { Args: never; Returns: boolean }
      is_owner: { Args: never; Returns: boolean }
      my_admin_company_ids: { Args: never; Returns: string[] }
      my_tools_pending: { Args: never; Returns: boolean }
      my_worker_id: { Args: never; Returns: string }
      payments_misc_items_ok: { Args: { items: Json }; Returns: boolean }
      reveal_worker_tools: { Args: { p_worker_id: string }; Returns: Json }
      set_time_entry_activity: { Args: { p: Json }; Returns: number }
      set_tools_requested: {
        Args: { p_requested: Json; p_worker_id: string }
        Returns: undefined
      }
      set_worker_tools: {
        Args: { p_creds: Json; p_worker_id: string }
        Returns: undefined
      }
      worker_has_payment_in_period: { Args: { pid: string }; Returns: boolean }
    }
    Enums: {
      agreement_kind:
        | "ic_agreement"
        | "non_compete"
        | "confidentiality_nda"
        | "baa"
      approval_status: "pending" | "approved" | "rejected"
      company_status: "active" | "inactive"
      contract_type: "FT" | "PT" | "PH" | "PS" | "PHS"
      document_kind:
        | "ic_agreement"
        | "w8ben"
        | "gov_id"
        | "other"
        | "resume"
        | "diploma"
        | "nbi_clearance"
      onboarding_stage:
        | "stage1_sign"
        | "stage2_profile"
        | "stage3_docs"
        | "complete"
      pay_period_state: "open" | "locked" | "paid"
      payment_status: "draft" | "queued" | "sent" | "failed" | "reconciled"
      payout_method: "wise" | "bpi" | "gcash" | "paymaya" | "paypal"
      portal_notification_kind:
        | "stage_complete"
        | "upload_received"
        | "doc_approved"
        | "doc_needs_replacement"
        | "onboarding_complete"
        | "onboarding_stalled"
      review_status:
        | "pending"
        | "approved"
        | "needs_replacement"
        | "waived"
        | "deferred"
      signature_method: "typed" | "drawn"
      signature_status: "signed" | "superseded" | "disputed"
      worker_status: "active" | "inactive" | "ended"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      agreement_kind: [
        "ic_agreement",
        "non_compete",
        "confidentiality_nda",
        "baa",
      ],
      approval_status: ["pending", "approved", "rejected"],
      company_status: ["active", "inactive"],
      contract_type: ["FT", "PT", "PH", "PS", "PHS"],
      document_kind: [
        "ic_agreement",
        "w8ben",
        "gov_id",
        "other",
        "resume",
        "diploma",
        "nbi_clearance",
      ],
      onboarding_stage: [
        "stage1_sign",
        "stage2_profile",
        "stage3_docs",
        "complete",
      ],
      pay_period_state: ["open", "locked", "paid"],
      payment_status: ["draft", "queued", "sent", "failed", "reconciled"],
      payout_method: ["wise", "bpi", "gcash", "paymaya", "paypal"],
      portal_notification_kind: [
        "stage_complete",
        "upload_received",
        "doc_approved",
        "doc_needs_replacement",
        "onboarding_complete",
        "onboarding_stalled",
      ],
      review_status: [
        "pending",
        "approved",
        "needs_replacement",
        "waived",
        "deferred",
      ],
      signature_method: ["typed", "drawn"],
      signature_status: ["signed", "superseded", "disputed"],
      worker_status: ["active", "inactive", "ended"],
    },
  },
} as const

