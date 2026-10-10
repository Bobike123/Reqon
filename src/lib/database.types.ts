export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      activity: {
        Row: {
          action: string
          actor_id: string | null
          at: string
          detail: Json | null
          entity: string
          entity_id: string
          id: number
          season_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          at?: string
          detail?: Json | null
          entity: string
          entity_id: string
          id?: number
          season_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          at?: string
          detail?: Json | null
          entity?: string
          entity_id?: string
          id?: number
          season_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
      attachment_purge_queue: {
        Row: {
          attachment_id: string | null
          id: number
          kind: string
          object_keys: string[]
          purge_after: string
          purged_at: string | null
          queued_at: string
          reason: string
          size_bytes: number
          task_id: string | null
        }
        Insert: {
          attachment_id?: string | null
          id?: never
          kind: string
          object_keys: string[]
          purge_after: string
          purged_at?: string | null
          queued_at?: string
          reason: string
          size_bytes: number
          task_id?: string | null
        }
        Update: {
          attachment_id?: string | null
          id?: never
          kind?: string
          object_keys?: string[]
          purge_after?: string
          purged_at?: string | null
          queued_at?: string
          reason?: string
          size_bytes?: number
          task_id?: string | null
        }
        Relationships: []
      }
      attachment_quotas: {
        Row: {
          quota_bytes: number
          quota_group: string
        }
        Insert: {
          quota_bytes: number
          quota_group: string
        }
        Update: {
          quota_bytes?: number
          quota_group?: string
        }
        Relationships: []
      }
      backup_runs: {
        Row: {
          db_size_bytes: number | null
          destination: string
          detail: string | null
          id: number
          migration_version: string | null
          object_key: string | null
          ok: boolean
          recipients: string[]
          recorded_at: string
          row_count: number | null
          sha256: string | null
          size_bytes: number | null
          taken_at: string
        }
        Insert: {
          db_size_bytes?: number | null
          destination: string
          detail?: string | null
          id?: never
          migration_version?: string | null
          object_key?: string | null
          ok: boolean
          recipients?: string[]
          recorded_at?: string
          row_count?: number | null
          sha256?: string | null
          size_bytes?: number | null
          taken_at: string
        }
        Update: {
          db_size_bytes?: number | null
          destination?: string
          detail?: string | null
          id?: never
          migration_version?: string | null
          object_key?: string | null
          ok?: boolean
          recipients?: string[]
          recorded_at?: string
          row_count?: number | null
          sha256?: string | null
          size_bytes?: number | null
          taken_at?: string
        }
        Relationships: []
      }
      book_chapters: {
        Row: {
          category: string | null
          code: string
          has_numbered_rules: boolean
          heading: string
          label: string
          page: number | null
          regs_ref: string
          sort_order: number
        }
        Insert: {
          category?: string | null
          code: string
          has_numbered_rules: boolean
          heading: string
          label: string
          page?: number | null
          regs_ref: string
          sort_order: number
        }
        Update: {
          category?: string | null
          code?: string
          has_numbered_rules?: boolean
          heading?: string
          label?: string
          page?: number | null
          regs_ref?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "book_chapters_regs_ref_fkey"
            columns: ["regs_ref"]
            isOneToOne: false
            referencedRelation: "regulation_documents"
            referencedColumns: ["regs_ref"]
          },
        ]
      }
      book_subchapters: {
        Row: {
          chapter_code: string
          has_numbered_rules: boolean
          heading: string
          kind: string
          label: string
          number: number
          page: number | null
          regs_ref: string
          sort_order: number
        }
        Insert: {
          chapter_code: string
          has_numbered_rules: boolean
          heading: string
          kind: string
          label: string
          number: number
          page?: number | null
          regs_ref: string
          sort_order: number
        }
        Update: {
          chapter_code?: string
          has_numbered_rules?: boolean
          heading?: string
          kind?: string
          label?: string
          number?: number
          page?: number | null
          regs_ref?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "book_subchapters_regs_ref_chapter_code_fkey"
            columns: ["regs_ref", "chapter_code"]
            isOneToOne: false
            referencedRelation: "book_chapters"
            referencedColumns: ["regs_ref", "code"]
          },
        ]
      }
      clause_status: {
        Row: {
          clause_key: string
          evidence: string | null
          id: string
          owner_id: string | null
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["clause_state"]
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          clause_key: string
          evidence?: string | null
          id?: string
          owner_id?: string | null
          season_id: string
          starred?: boolean
          state?: Database["public"]["Enums"]["clause_state"]
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          clause_key?: string
          evidence?: string | null
          id?: string
          owner_id?: string | null
          season_id?: string
          starred?: boolean
          state?: Database["public"]["Enums"]["clause_state"]
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clause_status_clause_key_fkey"
            columns: ["clause_key"]
            isOneToOne: false
            referencedRelation: "clauses"
            referencedColumns: ["clause_key"]
          },
          {
            foreignKeyName: "clause_status_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clause_status_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clause_status_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clause_status_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "clause_status_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      clauses: {
        Row: {
          article: number
          article_title: string | null
          body: string
          clause_key: string
          criticality: string
          group_title: string | null
          is_team_duty: boolean
          milestone_key: string | null
          obligation: string
          phase: string | null
          printed_ref: string
          regs_ref: string | null
          section: string
          source_page: number | null
          source_subject_key: string | null
          specs: Json
          subteam_key: string | null
        }
        Insert: {
          article: number
          article_title?: string | null
          body: string
          clause_key: string
          criticality: string
          group_title?: string | null
          is_team_duty?: boolean
          milestone_key?: string | null
          obligation: string
          phase?: string | null
          printed_ref: string
          regs_ref?: string | null
          section: string
          source_page?: number | null
          source_subject_key?: string | null
          specs?: Json
          subteam_key?: string | null
        }
        Update: {
          article?: number
          article_title?: string | null
          body?: string
          clause_key?: string
          criticality?: string
          group_title?: string | null
          is_team_duty?: boolean
          milestone_key?: string | null
          obligation?: string
          phase?: string | null
          printed_ref?: string
          regs_ref?: string | null
          section?: string
          source_page?: number | null
          source_subject_key?: string | null
          specs?: Json
          subteam_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clauses_regs_ref_fkey"
            columns: ["regs_ref"]
            isOneToOne: false
            referencedRelation: "regulation_documents"
            referencedColumns: ["regs_ref"]
          },
          {
            foreignKeyName: "clauses_source_subject_key_fkey"
            columns: ["source_subject_key"]
            isOneToOne: false
            referencedRelation: "regulation_subjects"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "clauses_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "subteams"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "clauses_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["key"]
          },
        ]
      }
      contact_categories: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_categories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          category_id: string
          created_at: string
          created_by: string | null
          email: string | null
          help: string
          id: string
          name: string
          phone: string | null
          title: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          category_id: string
          created_at?: string
          created_by?: string | null
          email?: string | null
          help: string
          id?: string
          name: string
          phone?: string | null
          title?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          category_id?: string
          created_at?: string
          created_by?: string | null
          email?: string | null
          help?: string
          id?: string
          name?: string
          phone?: string | null
          title?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "contact_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      department_members: {
        Row: {
          added_at: string
          added_by: string | null
          member_id: string
          season_id: string
          subteam_key: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          member_id: string
          season_id: string
          subteam_key: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          member_id?: string
          season_id?: string
          subteam_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "department_members_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_members_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_members_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_members_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_members_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "department_members_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "subteams"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "department_members_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["key"]
          },
        ]
      }
      finance_entries: {
        Row: {
          amount_cents: number
          category: string | null
          created_at: string
          created_by: string | null
          description: string
          entry_date: string
          id: string
          kind: Database["public"]["Enums"]["finance_kind"]
          season_id: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          category?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          entry_date?: string
          id?: string
          kind: Database["public"]["Enums"]["finance_kind"]
          season_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          category?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          entry_date?: string
          id?: string
          kind?: Database["public"]["Enums"]["finance_kind"]
          season_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_entries_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_entries_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_entries_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
      handover_notes: {
        Row: {
          body: string
          id: string
          season_id: string
          subteam_key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          body?: string
          id?: string
          season_id: string
          subteam_key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          body?: string
          id?: string
          season_id?: string
          subteam_key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handover_notes_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_notes_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_notes_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "handover_notes_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "subteams"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "handover_notes_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "handover_notes_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_template: {
        Row: {
          body: string
          id: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          body: string
          id?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          body?: string
          id?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_template_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          agenda: string | null
          attendees: string | null
          created_at: string
          created_by: string | null
          ends_at: string | null
          held_on: string
          id: string
          location: string | null
          notes: string | null
          season_id: string
          starts_at: string | null
          summary: string | null
          title: string
          updated_at: string
        }
        Insert: {
          agenda?: string | null
          attendees?: string | null
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          held_on: string
          id?: string
          location?: string | null
          notes?: string | null
          season_id: string
          starts_at?: string | null
          summary?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          agenda?: string | null
          attendees?: string | null
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          held_on?: string
          id?: string
          location?: string | null
          notes?: string | null
          season_id?: string
          starts_at?: string | null
          summary?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
      member_roles: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          member_id: string
          role: Database["public"]["Enums"]["privileged_role"]
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          member_id: string
          role: Database["public"]["Enums"]["privileged_role"]
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          member_id?: string
          role?: Database["public"]["Enums"]["privileged_role"]
        }
        Relationships: [
          {
            foreignKeyName: "member_roles_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_roles_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      members: {
        Row: {
          created_at: string
          full_name: string
          id: string
          initials: string | null
          notes: string | null
          phone: string | null
          role: string
          skills: string | null
          status: Database["public"]["Enums"]["member_state"]
          study_year: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id: string
          initials?: string | null
          notes?: string | null
          phone?: string | null
          role?: string
          skills?: string | null
          status?: Database["public"]["Enums"]["member_state"]
          study_year?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          initials?: string | null
          notes?: string | null
          phone?: string | null
          role?: string
          skills?: string | null
          status?: Database["public"]["Enums"]["member_state"]
          study_year?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      milestone_sections: {
        Row: {
          id: string
          is_drafted: boolean
          milestone_key: string
          name: string
          ordinal: number
          owner_id: string | null
          parent_section_id: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          is_drafted?: boolean
          milestone_key: string
          name: string
          ordinal: number
          owner_id?: string | null
          parent_section_id?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          is_drafted?: boolean
          milestone_key?: string
          name?: string
          ordinal?: number
          owner_id?: string | null
          parent_section_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "milestone_sections_milestone_key_fkey"
            columns: ["milestone_key"]
            isOneToOne: false
            referencedRelation: "milestones"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "milestone_sections_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "milestone_sections_parent_section_id_fkey"
            columns: ["parent_section_id"]
            isOneToOne: false
            referencedRelation: "milestone_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      milestones: {
        Row: {
          accepted_by: string | null
          accepted_on: string | null
          aim: string | null
          article_ref: string | null
          code: string
          due_on: string | null
          is_blocking: boolean
          key: string
          max_points: number
          name: string
          notes: string | null
          opens_on: string | null
          ordinal: number
          season_id: string
          submitted_by: string | null
          submitted_on: string | null
        }
        Insert: {
          accepted_by?: string | null
          accepted_on?: string | null
          aim?: string | null
          article_ref?: string | null
          code: string
          due_on?: string | null
          is_blocking?: boolean
          key: string
          max_points?: number
          name: string
          notes?: string | null
          opens_on?: string | null
          ordinal: number
          season_id: string
          submitted_by?: string | null
          submitted_on?: string | null
        }
        Update: {
          accepted_by?: string | null
          accepted_on?: string | null
          aim?: string | null
          article_ref?: string | null
          code?: string
          due_on?: string | null
          is_blocking?: boolean
          key?: string
          max_points?: number
          name?: string
          notes?: string | null
          opens_on?: string | null
          ordinal?: number
          season_id?: string
          submitted_by?: string | null
          submitted_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "milestones_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "milestones_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "milestones_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "milestones_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "milestones_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      proposal_comments: {
        Row: {
          author_id: string
          body: string
          created_at: string
          id: string
          kind: string
          proposal_id: string
          revision: number
          season_id: string
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          id?: string
          kind?: string
          proposal_id: string
          revision: number
          season_id: string
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          kind?: string
          proposal_id?: string
          revision?: number
          season_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposal_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_comments_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "task_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_comments_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_comments_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_comments_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
      proposal_requirements: {
        Row: {
          clause_key: string
          created_at: string
          created_by: string | null
          proposal_id: string
          season_id: string
        }
        Insert: {
          clause_key: string
          created_at?: string
          created_by?: string | null
          proposal_id: string
          season_id: string
        }
        Update: {
          clause_key?: string
          created_at?: string
          created_by?: string | null
          proposal_id?: string
          season_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposal_requirements_clause_key_fkey"
            columns: ["clause_key"]
            isOneToOne: false
            referencedRelation: "clauses"
            referencedColumns: ["clause_key"]
          },
          {
            foreignKeyName: "proposal_requirements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_requirements_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "task_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_requirements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_requirements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_requirements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
      regulation_documents: {
        Row: {
          edition: string | null
          page_count: number | null
          page_offset: number
          regs_ref: string
          storage_path: string | null
          title: string | null
          updated_at: string
          updated_by: string | null
          url: string | null
        }
        Insert: {
          edition?: string | null
          page_count?: number | null
          page_offset?: number
          regs_ref: string
          storage_path?: string | null
          title?: string | null
          updated_at?: string
          updated_by?: string | null
          url?: string | null
        }
        Update: {
          edition?: string | null
          page_count?: number | null
          page_offset?: number
          regs_ref?: string
          storage_path?: string | null
          title?: string | null
          updated_at?: string
          updated_by?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "regulation_documents_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_subjects: {
        Row: {
          book_section: string | null
          description: string | null
          is_parked: boolean
          key: string
          name: string
          sort_order: number
        }
        Insert: {
          book_section?: string | null
          description?: string | null
          is_parked?: boolean
          key: string
          name: string
          sort_order?: number
        }
        Update: {
          book_section?: string | null
          description?: string | null
          is_parked?: boolean
          key?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      seasons: {
        Row: {
          bike_number: number | null
          category: string
          club_name: string
          created_at: string
          edition: string
          id: string
          is_current: boolean
          label: string
          regs_ref: string
          university: string
        }
        Insert: {
          bike_number?: number | null
          category?: string
          club_name?: string
          created_at?: string
          edition?: string
          id?: string
          is_current?: boolean
          label: string
          regs_ref?: string
          university?: string
        }
        Update: {
          bike_number?: number | null
          category?: string
          club_name?: string
          created_at?: string
          edition?: string
          id?: string
          is_current?: boolean
          label?: string
          regs_ref?: string
          university?: string
        }
        Relationships: []
      }
      spec_measurements: {
        Row: {
          context: string
          corrects_id: string | null
          id: string
          invalidated_at: string | null
          invalidated_by: string | null
          invalidation_reason: string | null
          measured_at: string | null
          measured_by: string | null
          note: string | null
          origin: string
          recorded_at: string
          request_id: string
          season_id: string
          source: string | null
          spec_id: string
          value_bool: boolean | null
          value_numeric: number | null
        }
        Insert: {
          context?: string
          corrects_id?: string | null
          id?: string
          invalidated_at?: string | null
          invalidated_by?: string | null
          invalidation_reason?: string | null
          measured_at?: string | null
          measured_by?: string | null
          note?: string | null
          origin?: string
          recorded_at?: string
          request_id?: string
          season_id: string
          source?: string | null
          spec_id: string
          value_bool?: boolean | null
          value_numeric?: number | null
        }
        Update: {
          context?: string
          corrects_id?: string | null
          id?: string
          invalidated_at?: string | null
          invalidated_by?: string | null
          invalidation_reason?: string | null
          measured_at?: string | null
          measured_by?: string | null
          note?: string | null
          origin?: string
          recorded_at?: string
          request_id?: string
          season_id?: string
          source?: string | null
          spec_id?: string
          value_bool?: boolean | null
          value_numeric?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "spec_measurements_corrects_id_fkey"
            columns: ["corrects_id"]
            isOneToOne: false
            referencedRelation: "spec_measurements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_corrects_id_fkey"
            columns: ["corrects_id"]
            isOneToOne: false
            referencedRelation: "spec_verdicts"
            referencedColumns: ["competition_measurement_id"]
          },
          {
            foreignKeyName: "spec_measurements_corrects_id_fkey"
            columns: ["corrects_id"]
            isOneToOne: false
            referencedRelation: "v_spec_competition_current"
            referencedColumns: ["measurement_id"]
          },
          {
            foreignKeyName: "spec_measurements_invalidated_by_fkey"
            columns: ["invalidated_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_measured_by_fkey"
            columns: ["measured_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "spec_measurements_spec_id_fkey"
            columns: ["spec_id"]
            isOneToOne: false
            referencedRelation: "spec_verdicts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_spec_id_fkey"
            columns: ["spec_id"]
            isOneToOne: false
            referencedRelation: "specs"
            referencedColumns: ["id"]
          },
        ]
      }
      spec_readiness: {
        Row: {
          confirmed_at: string
          confirmed_by: string | null
          id: string
          measurement_id: string
          note: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          season_id: string
          spec_id: string
        }
        Insert: {
          confirmed_at?: string
          confirmed_by?: string | null
          id?: string
          measurement_id: string
          note: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          season_id: string
          spec_id: string
        }
        Update: {
          confirmed_at?: string
          confirmed_by?: string | null
          id?: string
          measurement_id?: string
          note?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          season_id?: string
          spec_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "spec_readiness_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_readiness_measurement_id_fkey"
            columns: ["measurement_id"]
            isOneToOne: false
            referencedRelation: "spec_measurements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_readiness_measurement_id_fkey"
            columns: ["measurement_id"]
            isOneToOne: false
            referencedRelation: "spec_verdicts"
            referencedColumns: ["competition_measurement_id"]
          },
          {
            foreignKeyName: "spec_readiness_measurement_id_fkey"
            columns: ["measurement_id"]
            isOneToOne: false
            referencedRelation: "v_spec_competition_current"
            referencedColumns: ["measurement_id"]
          },
          {
            foreignKeyName: "spec_readiness_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_readiness_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_readiness_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_readiness_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "spec_readiness_spec_id_fkey"
            columns: ["spec_id"]
            isOneToOne: false
            referencedRelation: "spec_verdicts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_readiness_spec_id_fkey"
            columns: ["spec_id"]
            isOneToOne: false
            referencedRelation: "specs"
            referencedColumns: ["id"]
          },
        ]
      }
      specs: {
        Row: {
          acceptable: number | null
          clause_key: string | null
          comparator: string
          condition: string | null
          current_measurement_id: string | null
          direction: string
          direction_note: string | null
          direction_reviewed_at: string | null
          direction_reviewed_by: string | null
          goal: number | null
          goal_bool: boolean | null
          goal_max: number | null
          goal_tolerance: number | null
          id: string
          ideal: number | null
          measure_kind: string | null
          measured: number | null
          measured_at: string | null
          measured_bool: boolean | null
          measured_by: string | null
          parameter: string
          plausible_max: number | null
          plausible_min: number | null
          season_id: string
          sort_order: number
          target: number | null
          target_bool: boolean | null
          target_max: number | null
          target_max_inclusive: boolean
          target_min_inclusive: boolean
          target_text: string | null
          target_tolerance: number | null
          unit: string | null
        }
        Insert: {
          acceptable?: number | null
          clause_key?: string | null
          comparator: string
          condition?: string | null
          current_measurement_id?: string | null
          direction: string
          direction_note?: string | null
          direction_reviewed_at?: string | null
          direction_reviewed_by?: string | null
          goal?: number | null
          goal_bool?: boolean | null
          goal_max?: number | null
          goal_tolerance?: number | null
          id?: string
          ideal?: number | null
          measure_kind?: string | null
          measured?: number | null
          measured_at?: string | null
          measured_bool?: boolean | null
          measured_by?: string | null
          parameter: string
          plausible_max?: number | null
          plausible_min?: number | null
          season_id: string
          sort_order?: number
          target?: number | null
          target_bool?: boolean | null
          target_max?: number | null
          target_max_inclusive?: boolean
          target_min_inclusive?: boolean
          target_text?: string | null
          target_tolerance?: number | null
          unit?: string | null
        }
        Update: {
          acceptable?: number | null
          clause_key?: string | null
          comparator?: string
          condition?: string | null
          current_measurement_id?: string | null
          direction?: string
          direction_note?: string | null
          direction_reviewed_at?: string | null
          direction_reviewed_by?: string | null
          goal?: number | null
          goal_bool?: boolean | null
          goal_max?: number | null
          goal_tolerance?: number | null
          id?: string
          ideal?: number | null
          measure_kind?: string | null
          measured?: number | null
          measured_at?: string | null
          measured_bool?: boolean | null
          measured_by?: string | null
          parameter?: string
          plausible_max?: number | null
          plausible_min?: number | null
          season_id?: string
          sort_order?: number
          target?: number | null
          target_bool?: boolean | null
          target_max?: number | null
          target_max_inclusive?: boolean
          target_min_inclusive?: boolean
          target_text?: string | null
          target_tolerance?: number | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "specs_clause_key_fkey"
            columns: ["clause_key"]
            isOneToOne: false
            referencedRelation: "clauses"
            referencedColumns: ["clause_key"]
          },
          {
            foreignKeyName: "specs_current_measurement_fkey"
            columns: ["current_measurement_id"]
            isOneToOne: false
            referencedRelation: "spec_measurements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_current_measurement_fkey"
            columns: ["current_measurement_id"]
            isOneToOne: false
            referencedRelation: "spec_verdicts"
            referencedColumns: ["competition_measurement_id"]
          },
          {
            foreignKeyName: "specs_current_measurement_fkey"
            columns: ["current_measurement_id"]
            isOneToOne: false
            referencedRelation: "v_spec_competition_current"
            referencedColumns: ["measurement_id"]
          },
          {
            foreignKeyName: "specs_direction_reviewed_by_fkey"
            columns: ["direction_reviewed_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_measured_by_fkey"
            columns: ["measured_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
      subteams: {
        Row: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          book_section: string | null
          description: string | null
          is_parked: boolean
          key: string
          lead_id: string | null
          name: string
          parent_key: string | null
          sort_order: number
        }
        Insert: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          book_section?: string | null
          description?: string | null
          is_parked?: boolean
          key: string
          lead_id?: string | null
          name: string
          parent_key?: string | null
          sort_order?: number
        }
        Update: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          book_section?: string | null
          description?: string | null
          is_parked?: boolean
          key?: string
          lead_id?: string | null
          name?: string
          parent_key?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "subteams_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subteams_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subteams_parent_key_fkey"
            columns: ["parent_key"]
            isOneToOne: false
            referencedRelation: "subteams"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "subteams_parent_key_fkey"
            columns: ["parent_key"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["key"]
          },
        ]
      }
      task_attachments: {
        Row: {
          caption: string | null
          created_at: string
          deleted_at: string | null
          duration_ms: number | null
          failure_reason: string | null
          height: number | null
          id: string
          kind: string
          mime_type: string
          object_key: string
          original_name: string
          playable: boolean
          size_bytes: number
          status: string
          task_id: string
          thumb_key: string | null
          updated_at: string
          uploaded_by: string | null
          width: number | null
        }
        Insert: {
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          duration_ms?: number | null
          failure_reason?: string | null
          height?: number | null
          id?: string
          kind: string
          mime_type: string
          object_key: string
          original_name: string
          playable?: boolean
          size_bytes: number
          status?: string
          task_id: string
          thumb_key?: string | null
          updated_at?: string
          uploaded_by?: string | null
          width?: number | null
        }
        Update: {
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          duration_ms?: number | null
          failure_reason?: string | null
          height?: number | null
          id?: string
          kind?: string
          mime_type?: string
          object_key?: string
          original_name?: string
          playable?: boolean
          size_bytes?: number
          status?: string
          task_id?: string
          thumb_key?: string | null
          updated_at?: string
          uploaded_by?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "task_attachments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      task_dependencies: {
        Row: {
          created_at: string
          created_by: string | null
          depends_on_task_id: string
          season_id: string
          task_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          depends_on_task_id: string
          season_id: string
          task_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          depends_on_task_id?: string
          season_id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_dependencies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_dependencies_depends_on_task_id_fkey"
            columns: ["depends_on_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_dependencies_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_dependencies_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_dependencies_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "task_dependencies_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_proposals: {
        Row: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        Insert: {
          approved_as?: string | null
          approved_at?: string | null
          approved_by?: string | null
          approved_digest?: string | null
          approved_revision?: number | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          context?: string | null
          decided_at?: string | null
          decision?: string | null
          due_date?: string | null
          id?: string
          legacy_incomplete?: boolean
          meeting_id?: string | null
          milestone_key?: string | null
          outcome?: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          raised_by?: string | null
          raised_on?: string
          revision?: number
          season_id: string
          starred?: boolean
          state?: Database["public"]["Enums"]["topic_state"]
          subteam_key?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          approved_as?: string | null
          approved_at?: string | null
          approved_by?: string | null
          approved_digest?: string | null
          approved_revision?: number | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          context?: string | null
          decided_at?: string | null
          decision?: string | null
          due_date?: string | null
          id?: string
          legacy_incomplete?: boolean
          meeting_id?: string | null
          milestone_key?: string | null
          outcome?: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          raised_by?: string | null
          raised_on?: string
          revision?: number
          season_id?: string
          starred?: boolean
          state?: Database["public"]["Enums"]["topic_state"]
          subteam_key?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_proposals_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_proposals_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_proposals_milestone_key_fkey"
            columns: ["milestone_key"]
            isOneToOne: false
            referencedRelation: "milestones"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "task_proposals_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "subteams"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "task_proposals_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "topics_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topics_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topics_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topics_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topics_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topics_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
      task_requirements: {
        Row: {
          clause_key: string
          created_at: string
          created_by: string | null
          season_id: string
          task_id: string
        }
        Insert: {
          clause_key: string
          created_at?: string
          created_by?: string | null
          season_id: string
          task_id: string
        }
        Update: {
          clause_key?: string
          created_at?: string
          created_by?: string | null
          season_id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_requirements_clause_key_fkey"
            columns: ["clause_key"]
            isOneToOne: false
            referencedRelation: "clauses"
            referencedColumns: ["clause_key"]
          },
          {
            foreignKeyName: "task_requirements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requirements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requirements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requirements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "task_requirements_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          blocked_reason: string | null
          blocked_since: string | null
          completed_at: string | null
          completion_source: string | null
          created_at: string
          created_by: string | null
          detail: string | null
          due_date: string | null
          id: string
          links_required: boolean
          milestone_key: string | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          season_id: string
          section_id: string | null
          source_proposal: string | null
          starred: boolean
          starts_on: string | null
          state: Database["public"]["Enums"]["task_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        Insert: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          blocked_reason?: string | null
          blocked_since?: string | null
          completed_at?: string | null
          completion_source?: string | null
          created_at?: string
          created_by?: string | null
          detail?: string | null
          due_date?: string | null
          id?: string
          links_required?: boolean
          milestone_key?: string | null
          owner_id?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          season_id: string
          section_id?: string | null
          source_proposal?: string | null
          starred?: boolean
          starts_on?: string | null
          state?: Database["public"]["Enums"]["task_state"]
          subteam_key?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          blocked_reason?: string | null
          blocked_since?: string | null
          completed_at?: string | null
          completion_source?: string | null
          created_at?: string
          created_by?: string | null
          detail?: string | null
          due_date?: string | null
          id?: string
          links_required?: boolean
          milestone_key?: string | null
          owner_id?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          season_id?: string
          section_id?: string | null
          source_proposal?: string | null
          starred?: boolean
          starts_on?: string | null
          state?: Database["public"]["Enums"]["task_state"]
          subteam_key?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_milestone_key_fkey"
            columns: ["milestone_key"]
            isOneToOne: false
            referencedRelation: "milestones"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "tasks_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "tasks_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "milestone_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_source_topic_fkey"
            columns: ["source_proposal"]
            isOneToOne: false
            referencedRelation: "task_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "subteams"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "tasks_subteam_key_fkey"
            columns: ["subteam_key"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["key"]
          },
        ]
      }
    }
    Views: {
      spec_verdicts: {
        Row: {
          acceptable: number | null
          clause_key: string | null
          comparator: string | null
          competition_measured_at: string | null
          competition_measurement_id: string | null
          competition_value: number | null
          competition_value_bool: boolean | null
          competition_verdict: string | null
          condition: string | null
          current_measurement_id: string | null
          direction: string | null
          direction_needs_review: boolean | null
          direction_note: string | null
          direction_reviewed_at: string | null
          direction_reviewed_by: string | null
          goal: number | null
          goal_bool: boolean | null
          goal_max: number | null
          goal_status: string | null
          goal_tolerance: number | null
          id: string | null
          ideal: number | null
          measure_kind: string | null
          measured: number | null
          measured_at: string | null
          measured_bool: boolean | null
          measured_by: string | null
          parameter: string | null
          plausible_max: number | null
          plausible_min: number | null
          readiness: string | null
          readiness_confirmed_at: string | null
          readiness_confirmed_by: string | null
          readiness_measurement_id: string | null
          readiness_note: string | null
          readiness_reason: string | null
          readiness_revoked_at: string | null
          season_id: string | null
          sort_order: number | null
          target: number | null
          target_bool: boolean | null
          target_max: number | null
          target_max_inclusive: boolean | null
          target_min_inclusive: boolean | null
          target_text: string | null
          target_tolerance: number | null
          unit: string | null
          verdict: string | null
          zone: string | null
        }
        Relationships: [
          {
            foreignKeyName: "spec_readiness_confirmed_by_fkey"
            columns: ["readiness_confirmed_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_readiness_measurement_id_fkey"
            columns: ["readiness_measurement_id"]
            isOneToOne: false
            referencedRelation: "spec_measurements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_readiness_measurement_id_fkey"
            columns: ["readiness_measurement_id"]
            isOneToOne: false
            referencedRelation: "spec_verdicts"
            referencedColumns: ["competition_measurement_id"]
          },
          {
            foreignKeyName: "spec_readiness_measurement_id_fkey"
            columns: ["readiness_measurement_id"]
            isOneToOne: false
            referencedRelation: "v_spec_competition_current"
            referencedColumns: ["measurement_id"]
          },
          {
            foreignKeyName: "specs_clause_key_fkey"
            columns: ["clause_key"]
            isOneToOne: false
            referencedRelation: "clauses"
            referencedColumns: ["clause_key"]
          },
          {
            foreignKeyName: "specs_current_measurement_fkey"
            columns: ["current_measurement_id"]
            isOneToOne: false
            referencedRelation: "spec_measurements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_current_measurement_fkey"
            columns: ["current_measurement_id"]
            isOneToOne: false
            referencedRelation: "spec_verdicts"
            referencedColumns: ["competition_measurement_id"]
          },
          {
            foreignKeyName: "specs_current_measurement_fkey"
            columns: ["current_measurement_id"]
            isOneToOne: false
            referencedRelation: "v_spec_competition_current"
            referencedColumns: ["measurement_id"]
          },
          {
            foreignKeyName: "specs_direction_reviewed_by_fkey"
            columns: ["direction_reviewed_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_measured_by_fkey"
            columns: ["measured_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specs_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
      v_book_progress: {
        Row: {
          applicable: number | null
          blocked: number | null
          chapter_code: string | null
          chapter_sort: number | null
          complied: number | null
          content_state: string | null
          has_numbered_rules: boolean | null
          heading: string | null
          imported_rules: number | null
          in_progress: number | null
          kind: string | null
          label: string | null
          level: string | null
          not_applicable: number | null
          number: number | null
          out_of_scope: boolean | null
          page: number | null
          regs_ref: string | null
          requirements: number | null
          resolved: number | null
          season_id: string | null
          sort_order: number | null
          verified: number | null
        }
        Relationships: []
      }
      v_current_season: {
        Row: {
          bike_number: number | null
          category: string | null
          club_name: string | null
          created_at: string | null
          edition: string | null
          id: string | null
          is_current: boolean | null
          label: string | null
          regs_ref: string | null
          university: string | null
        }
        Relationships: []
      }
      v_spec_competition_current: {
        Row: {
          measured_at: string | null
          measured_by: string | null
          measurement_id: string | null
          recorded_at: string | null
          season_id: string | null
          spec_id: string | null
          value_bool: boolean | null
          value_numeric: number | null
        }
        Relationships: [
          {
            foreignKeyName: "spec_measurements_measured_by_fkey"
            columns: ["measured_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
          {
            foreignKeyName: "spec_measurements_spec_id_fkey"
            columns: ["spec_id"]
            isOneToOne: false
            referencedRelation: "spec_verdicts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_measurements_spec_id_fkey"
            columns: ["spec_id"]
            isOneToOne: false
            referencedRelation: "specs"
            referencedColumns: ["id"]
          },
        ]
      }
      v_subteam_progress: {
        Row: {
          applicable: number | null
          blocked: number | null
          book_section: string | null
          complied: number | null
          duties: number | null
          in_progress: number | null
          is_parked: boolean | null
          key: string | null
          lead_id: string | null
          name: string | null
          not_applicable: number | null
          resolved: number | null
          season_id: string | null
          total_rules: number | null
          verified: number | null
        }
        Relationships: [
          {
            foreignKeyName: "subteams_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      v_task_progress: {
        Row: {
          archived_done: number | null
          archived_unfinished: number | null
          cancelled: number | null
          done: number | null
          open_active: number | null
          percent: number | null
          scope: string | null
          scope_key: string | null
          season_id: string | null
          total: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      add_department_member: {
        Args: {
          p_member_id: string
          p_season_id: string
          p_subteam_key: string
        }
        Returns: boolean
      }
      add_proposal_comment: {
        Args: { p_body: string; p_proposal_id: string }
        Returns: {
          author_id: string
          body: string
          created_at: string
          id: string
          kind: string
          proposal_id: string
          revision: number
          season_id: string
        }
        SetofOptions: {
          from: "*"
          to: "proposal_comments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      add_task_dependency: {
        Args: { p_depends_on_task_id: string; p_task_id: string }
        Returns: boolean
      }
      apply_role_plan: { Args: { p_changes: Json }; Returns: undefined }
      approve_and_promote: {
        Args: {
          p_expected_revision: number
          p_note: string
          p_owner_id?: string
          p_proposal_id: string
          p_season_id: string
          p_starts_on?: string
        }
        Returns: {
          created: boolean
          task: Database["public"]["Tables"]["tasks"]["Row"]
        }[]
      }
      approve_proposal: {
        Args: {
          p_expected_revision: number
          p_note: string
          p_proposal_id: string
        }
        Returns: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "task_proposals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      archive_stale_done_tasks: {
        Args: never
        Returns: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          blocked_reason: string | null
          blocked_since: string | null
          completed_at: string | null
          completion_source: string | null
          created_at: string
          created_by: string | null
          detail: string | null
          due_date: string | null
          id: string
          links_required: boolean
          milestone_key: string | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          season_id: string
          section_id: string | null
          source_proposal: string | null
          starred: boolean
          starts_on: string | null
          state: Database["public"]["Enums"]["task_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      archive_stale_done_tasks_at: {
        Args: { p_now: string }
        Returns: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          blocked_reason: string | null
          blocked_since: string | null
          completed_at: string | null
          completion_source: string | null
          created_at: string
          created_by: string | null
          detail: string | null
          due_date: string | null
          id: string
          links_required: boolean
          milestone_key: string | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          season_id: string
          section_id: string | null
          source_proposal: string | null
          starred: boolean
          starts_on: string | null
          state: Database["public"]["Enums"]["task_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      archive_task: {
        Args: { p_reason?: string; p_task_id: string }
        Returns: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          blocked_reason: string | null
          blocked_since: string | null
          completed_at: string | null
          completion_source: string | null
          created_at: string
          created_by: string | null
          detail: string | null
          due_date: string | null
          id: string
          links_required: boolean
          milestone_key: string | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          season_id: string
          section_id: string | null
          source_proposal: string | null
          starred: boolean
          starts_on: string | null
          state: Database["public"]["Enums"]["task_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      assert_task_links: { Args: { p_task_id: string }; Returns: undefined }
      attachment_mime_extension: {
        Args: { p_kind: string; p_mime: string }
        Returns: string
      }
      attachment_quota_group: { Args: { p_kind: string }; Returns: string }
      attachment_size_limit: { Args: { p_kind: string }; Returns: number }
      attachment_usage: {
        Args: never
        Returns: {
          quota_bytes: number
          quota_group: string
          used_bytes: number
        }[]
      }
      attachment_used_bytes: { Args: { p_group: string }; Returns: number }
      attention: {
        Args: { p_season: string; p_today: string }
        Returns: {
          clause_key: string
          is_blocked: boolean
          is_overdue: boolean
          is_starred: boolean
          is_urgent: boolean
          kind: string
          owner_id: string
          reason: string
          ref: string
          season_id: string
          starred: boolean
          title: string
        }[]
      }
      can_add_members: { Args: never; Returns: boolean }
      can_delete_records: { Args: never; Returns: boolean }
      can_edit_contacts: { Args: never; Returns: boolean }
      can_edit_meetings: { Args: never; Returns: boolean }
      can_edit_spec_targets: { Args: never; Returns: boolean }
      can_edit_task: { Args: { p_task_id: string }; Returns: boolean }
      can_grant_role: {
        Args: { p_role: Database["public"]["Enums"]["privileged_role"] }
        Returns: boolean
      }
      can_manage_department_members: {
        Args: { p_key: string }
        Returns: boolean
      }
      can_manage_departments: { Args: never; Returns: boolean }
      can_manage_finances: { Args: never; Returns: boolean }
      can_manage_milestone_structure: { Args: never; Returns: boolean }
      can_manage_roles: { Args: never; Returns: boolean }
      can_manage_seasons: { Args: never; Returns: boolean }
      can_manage_spec_evidence: {
        Args: { p_spec_id: string }
        Returns: boolean
      }
      can_review_proposal: { Args: { p_proposal_id: string }; Returns: boolean }
      can_view_finances: { Args: never; Returns: boolean }
      change_reason_detail: { Args: never; Returns: Json }
      clean_text: { Args: { p_text: string }; Returns: string }
      confirm_attachment: {
        Args: {
          p_actual_mime: string
          p_actual_size: number
          p_attachment_id: string
          p_thumb_present: boolean
          p_uploader: string
        }
        Returns: string
      }
      confirm_spec_readiness: {
        Args: { p_measurement_id: string; p_note: string; p_spec_id: string }
        Returns: {
          confirmed_at: string
          confirmed_by: string | null
          id: string
          measurement_id: string
          note: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          season_id: string
          spec_id: string
        }
        SetofOptions: {
          from: "*"
          to: "spec_readiness"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      correct_spec_measurement: {
        Args: {
          p_measured_at?: string
          p_measurement_id: string
          p_reason: string
          p_request_id: string
          p_unit?: string
          p_value_bool?: boolean
          p_value_numeric?: number
        }
        Returns: {
          context: string
          corrects_id: string | null
          id: string
          invalidated_at: string | null
          invalidated_by: string | null
          invalidation_reason: string | null
          measured_at: string | null
          measured_by: string | null
          note: string | null
          origin: string
          recorded_at: string
          request_id: string
          season_id: string
          source: string | null
          spec_id: string
          value_bool: boolean | null
          value_numeric: number | null
        }
        SetofOptions: {
          from: "*"
          to: "spec_measurements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      dearmor: { Args: { "": string }; Returns: string }
      delete_attachment: { Args: { p_attachment_id: string }; Returns: boolean }
      department_authority: { Args: { p_key: string }; Returns: string }
      enqueue_attachment_purge: {
        Args: {
          p_after: string
          p_reason: string
          p_row: Database["public"]["Tables"]["task_attachments"]["Row"]
        }
        Returns: undefined
      }
      fail_stale_attachment_uploads: {
        Args: { p_now?: string }
        Returns: number
      }
      gen_random_uuid: { Args: never; Returns: string }
      gen_salt: { Args: { "": string }; Returns: string }
      has_department_authority: { Args: { p_key: string }; Returns: boolean }
      has_role: {
        Args: { wanted: Database["public"]["Enums"]["privileged_role"] }
        Returns: boolean
      }
      invalidate_spec_measurement: {
        Args: { p_measurement_id: string; p_reason: string }
        Returns: {
          context: string
          corrects_id: string | null
          id: string
          invalidated_at: string | null
          invalidated_by: string | null
          invalidation_reason: string | null
          measured_at: string | null
          measured_by: string | null
          note: string | null
          origin: string
          recorded_at: string
          request_id: string
          season_id: string
          source: string | null
          spec_id: string
          value_bool: boolean | null
          value_numeric: number | null
        }
        SetofOptions: {
          from: "*"
          to: "spec_measurements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      is_active_member: { Args: never; Returns: boolean }
      is_admin: { Args: never; Returns: boolean }
      is_department_head: { Args: { p_key: string }; Returns: boolean }
      is_developer: { Args: never; Returns: boolean }
      is_finite_number: { Args: { n: number }; Returns: boolean }
      is_member: { Args: never; Returns: boolean }
      lapse_spec_readiness: {
        Args: { p_by?: string; p_reason: string; p_spec_id: string }
        Returns: boolean
      }
      link_task_requirement: {
        Args: { p_clause_key: string; p_task_id: string }
        Returns: boolean
      }
      list_due_attachment_purges: {
        Args: { p_limit?: number; p_now?: string }
        Returns: {
          id: number
          object_keys: string[]
          size_bytes: number
        }[]
      }
      lock_proposal_for_command: {
        Args: { p_proposal_id: string }
        Returns: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "task_proposals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      mark_attachment_purged: { Args: { p_ids: number[] }; Returns: number }
      pgp_armor_headers: {
        Args: { "": string }
        Returns: Record<string, unknown>[]
      }
      promote_proposal: {
        Args: {
          p_owner_id?: string
          p_proposal_id: string
          p_season_id: string
          p_starts_on?: string
        }
        Returns: {
          created: boolean
          task: Database["public"]["Tables"]["tasks"]["Row"]
        }[]
      }
      proposal_content_digest: {
        Args: { p_proposal_id: string }
        Returns: string
      }
      reconciliation_apply: { Args: { p_manifest: Json }; Returns: Json }
      reconciliation_preflight: {
        Args: { p_manifest: Json }
        Returns: {
          action: string
          active_tasks: number
          archived_tasks: number
          clauses: number
          duties: number
          handovers: number
          head_id: string
          head_status: string
          key: string
          ok: boolean
          problem: string
          unresolved_proposals: number
        }[]
      }
      record_backup_run: {
        Args: {
          p_db_size_bytes?: number
          p_destination: string
          p_detail?: string
          p_migration_version?: string
          p_object_key?: string
          p_ok: boolean
          p_recipients?: string[]
          p_row_count?: number
          p_sha256?: string
          p_size_bytes?: number
          p_taken_at: string
        }
        Returns: number
      }
      record_spec_measurement: {
        Args: {
          p_context?: string
          p_measured_at?: string
          p_note?: string
          p_request_id: string
          p_season_id: string
          p_source?: string
          p_spec_id: string
          p_unit?: string
          p_value_bool?: boolean
          p_value_numeric?: number
        }
        Returns: {
          context: string
          corrects_id: string | null
          id: string
          invalidated_at: string | null
          invalidated_by: string | null
          invalidation_reason: string | null
          measured_at: string | null
          measured_by: string | null
          note: string | null
          origin: string
          recorded_at: string
          request_id: string
          season_id: string
          source: string | null
          spec_id: string
          value_bool: boolean | null
          value_numeric: number | null
        }
        SetofOptions: {
          from: "*"
          to: "spec_measurements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      refresh_spec_current: { Args: { p_spec_id: string }; Returns: undefined }
      remove_department_member: {
        Args: {
          p_member_id: string
          p_season_id: string
          p_subteam_key: string
        }
        Returns: boolean
      }
      remove_task_dependency: {
        Args: { p_depends_on_task_id: string; p_task_id: string }
        Returns: boolean
      }
      reorder_departments: {
        Args: { p_ordered_keys: string[] }
        Returns: undefined
      }
      request_attachment_upload: {
        Args: {
          p_duration_ms?: number
          p_height?: number
          p_kind: string
          p_mime_type: string
          p_original_name: string
          p_playable?: boolean
          p_size_bytes: number
          p_task_id: string
          p_width?: number
        }
        Returns: {
          attachment_id: string
          object_key: string
          thumb_key: string
        }[]
      }
      request_proposal_changes: {
        Args: {
          p_expected_revision: number
          p_note: string
          p_proposal_id: string
        }
        Returns: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "task_proposals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      restore_task: {
        Args: { p_task_id: string }
        Returns: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          blocked_reason: string | null
          blocked_since: string | null
          completed_at: string | null
          completion_source: string | null
          created_at: string
          created_by: string | null
          detail: string | null
          due_date: string | null
          id: string
          links_required: boolean
          milestone_key: string | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          season_id: string
          section_id: string | null
          source_proposal: string | null
          starred: boolean
          starts_on: string | null
          state: Database["public"]["Enums"]["task_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      review_proposal: {
        Args: {
          p_action: string
          p_expected_revision: number
          p_note?: string
          p_proposal_id: string
        }
        Returns: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "task_proposals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      review_spec_direction: {
        Args: { p_direction: string; p_note: string; p_spec_id: string }
        Returns: {
          acceptable: number | null
          clause_key: string | null
          comparator: string
          condition: string | null
          current_measurement_id: string | null
          direction: string
          direction_note: string | null
          direction_reviewed_at: string | null
          direction_reviewed_by: string | null
          goal: number | null
          goal_bool: boolean | null
          goal_max: number | null
          goal_tolerance: number | null
          id: string
          ideal: number | null
          measure_kind: string | null
          measured: number | null
          measured_at: string | null
          measured_bool: boolean | null
          measured_by: string | null
          parameter: string
          plausible_max: number | null
          plausible_min: number | null
          season_id: string
          sort_order: number
          target: number | null
          target_bool: boolean | null
          target_max: number | null
          target_max_inclusive: boolean
          target_min_inclusive: boolean
          target_text: string | null
          target_tolerance: number | null
          unit: string | null
        }
        SetofOptions: {
          from: "*"
          to: "specs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revise_proposal: {
        Args: {
          p_changes: Json
          p_expected_revision: number
          p_note?: string
          p_proposal_id: string
        }
        Returns: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "task_proposals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_spec_readiness: {
        Args: { p_reason: string; p_spec_id: string }
        Returns: boolean
      }
      set_attachment_caption: {
        Args: { p_attachment_id: string; p_caption: string }
        Returns: boolean
      }
      set_current_season: { Args: { p_season_id: string }; Returns: undefined }
      set_milestone_submission: {
        Args: { p_accepted_on: string; p_key: string; p_submitted_on: string }
        Returns: {
          accepted_by: string | null
          accepted_on: string | null
          aim: string | null
          article_ref: string | null
          code: string
          due_on: string | null
          is_blocking: boolean
          key: string
          max_points: number
          name: string
          notes: string | null
          opens_on: string | null
          ordinal: number
          season_id: string
          submitted_by: string | null
          submitted_on: string | null
        }
        SetofOptions: {
          from: "*"
          to: "milestones"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_proposal_department: {
        Args: {
          p_expected_revision: number
          p_proposal_id: string
          p_reason: string
          p_subteam_key: string
        }
        Returns: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "task_proposals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_proposal_requirements: {
        Args: {
          p_clause_keys: string[]
          p_expected_revision: number
          p_proposal_id: string
        }
        Returns: undefined
      }
      set_proposal_star: {
        Args: { p_proposal_id: string; p_starred: boolean }
        Returns: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "task_proposals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_task_department: {
        Args: { p_reason: string; p_subteam_key: string; p_task_id: string }
        Returns: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          blocked_reason: string | null
          blocked_since: string | null
          completed_at: string | null
          completion_source: string | null
          created_at: string
          created_by: string | null
          detail: string | null
          due_date: string | null
          id: string
          links_required: boolean
          milestone_key: string | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          season_id: string
          section_id: string | null
          source_proposal: string | null
          starred: boolean
          starts_on: string | null
          state: Database["public"]["Enums"]["task_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      spec_goal_status: {
        Args: {
          p_acceptable: number
          p_bool: boolean
          p_direction: string
          p_goal: number
          p_goal_bool: boolean
          p_goal_max: number
          p_goal_tolerance: number
          p_num: number
        }
        Returns: string
      }
      spec_measurement_json: {
        Args: { m: Database["public"]["Tables"]["spec_measurements"]["Row"] }
        Returns: Json
      }
      spec_regulatory_verdict: {
        Args: {
          p_bool: boolean
          p_comparator: string
          p_max_inclusive: boolean
          p_min_inclusive: boolean
          p_num: number
          p_target: number
          p_target_bool: boolean
          p_target_max: number
          p_tolerance: number
        }
        Returns: string
      }
      spec_zone: {
        Args: { p_goal_status: string; p_verdict: string }
        Returns: string
      }
      start_season: {
        Args: {
          p_category: string
          p_copy_from?: string
          p_edition: string
          p_label: string
          p_regs_ref: string
        }
        Returns: {
          bike_number: number | null
          category: string
          club_name: string
          created_at: string
          edition: string
          id: string
          is_current: boolean
          label: string
          regs_ref: string
          university: string
        }
        SetofOptions: {
          from: "*"
          to: "seasons"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      submit_proposal: {
        Args: {
          p_clause_keys: string[]
          p_description?: string
          p_due_date: string
          p_milestone_key: string
          p_owner_id?: string
          p_priority?: Database["public"]["Enums"]["task_priority"]
          p_season_id: string
          p_subteam_key: string
          p_title: string
        }
        Returns: {
          approved_as: string | null
          approved_at: string | null
          approved_by: string | null
          approved_digest: string | null
          approved_revision: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          context: string | null
          decided_at: string | null
          decision: string | null
          due_date: string | null
          id: string
          legacy_incomplete: boolean
          meeting_id: string | null
          milestone_key: string | null
          outcome: Database["public"]["Enums"]["proposal_outcome"] | null
          owner_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          raised_by: string | null
          raised_on: string
          revision: number
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "task_proposals"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      unlink_task_requirement: {
        Args: { p_clause_key: string; p_task_id: string }
        Returns: boolean
      }
    }
    Enums: {
      clause_state: "open" | "wip" | "compliant" | "verified" | "blocked" | "na"
      finance_kind: "income" | "expense"
      member_state: "active" | "alumni"
      privileged_role:
        | "developer"
        | "treasurer"
        | "president"
        | "vicepresident"
        | "documentation"
      proposal_outcome: "approved" | "rejected"
      task_priority: "normal" | "urgent"
      task_state: "todo" | "wip" | "blocked" | "done" | "cancelled"
      topic_state:
        | "open"
        | "agenda"
        | "decided"
        | "parked"
        | "changes_requested"
        | "approved"
    }
    CompositeTypes: {
      department_reconciliation_entry: {
        key: string | null
        action: string | null
        name: string | null
        reason: string | null
        sort_order: number | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      clause_state: ["open", "wip", "compliant", "verified", "blocked", "na"],
      finance_kind: ["income", "expense"],
      member_state: ["active", "alumni"],
      privileged_role: [
        "developer",
        "treasurer",
        "president",
        "vicepresident",
        "documentation",
      ],
      proposal_outcome: ["approved", "rejected"],
      task_priority: ["normal", "urgent"],
      task_state: ["todo", "wip", "blocked", "done", "cancelled"],
      topic_state: [
        "open",
        "agenda",
        "decided",
        "parked",
        "changes_requested",
        "approved",
      ],
    },
  },
} as const

