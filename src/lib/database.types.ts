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
          updated_at: string
        }
        Insert: {
          id?: string
          is_drafted?: boolean
          milestone_key: string
          name: string
          ordinal: number
          owner_id?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          is_drafted?: boolean
          milestone_key?: string
          name?: string
          ordinal?: number
          owner_id?: string | null
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
        ]
      }
      milestones: {
        Row: {
          aim: string | null
          article_ref: string | null
          due_on: string | null
          is_blocking: boolean
          key: string
          max_points: number
          name: string
          notes: string | null
          opens_on: string | null
          ordinal: number
          season_id: string
        }
        Insert: {
          aim?: string | null
          article_ref?: string | null
          due_on?: string | null
          is_blocking?: boolean
          key: string
          max_points?: number
          name: string
          notes?: string | null
          opens_on?: string | null
          ordinal: number
          season_id: string
        }
        Update: {
          aim?: string | null
          article_ref?: string | null
          due_on?: string | null
          is_blocking?: boolean
          key?: string
          max_points?: number
          name?: string
          notes?: string | null
          opens_on?: string | null
          ordinal?: number
          season_id?: string
        }
        Relationships: [
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
      specs: {
        Row: {
          acceptable: number | null
          clause_key: string | null
          comparator: string
          condition: string | null
          current_measurement_id: string | null
          direction: string
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
        ]
      }
      task_proposals: {
        Row: {
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
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        Insert: {
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
          season_id: string
          starred?: boolean
          state?: Database["public"]["Enums"]["topic_state"]
          subteam_key?: string | null
          title: string
          updated_at?: string
        }
        Update: {
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
          season_id?: string
          starred?: boolean
          state?: Database["public"]["Enums"]["topic_state"]
          subteam_key?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
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
          condition: string | null
          current_measurement_id: string | null
          direction: string | null
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
          blocked: number | null
          chapter_code: string | null
          chapter_sort: number | null
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
      v_subteam_progress: {
        Row: {
          blocked: number | null
          book_section: string | null
          duties: number | null
          in_progress: number | null
          is_parked: boolean | null
          key: string | null
          lead_id: string | null
          name: string | null
          resolved: number | null
          season_id: string | null
          total_rules: number | null
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
    }
    Functions: {
      apply_role_plan: { Args: { p_changes: Json }; Returns: undefined }
      archive_stale_done_tasks: {
        Args: never
        Returns: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
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
      attention: {
        Args: { p_season: string; p_today: string }
        Returns: {
          clause_key: string
          kind: string
          owner_id: string
          reason: string
          ref: string
          season_id: string
          starred: boolean
          title: string
        }[]
      }
      can_delete_records: { Args: never; Returns: boolean }
      can_edit_spec_targets: { Args: never; Returns: boolean }
      can_edit_task: { Args: { p_task_id: string }; Returns: boolean }
      can_manage_departments: { Args: never; Returns: boolean }
      can_manage_finances: { Args: never; Returns: boolean }
      can_manage_roles: { Args: never; Returns: boolean }
      can_review_proposal: { Args: { p_proposal_id: string }; Returns: boolean }
      can_view_finances: { Args: never; Returns: boolean }
      correct_spec_measurement: {
        Args: {
          p_measured_at?: string
          p_measurement_id: string
          p_reason: string
          p_request_id: string
          p_value_bool?: boolean
          p_value_numeric?: number
        }
        Returns: {
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
      gen_random_uuid: { Args: never; Returns: string }
      gen_salt: { Args: { "": string }; Returns: string }
      has_role: {
        Args: { wanted: Database["public"]["Enums"]["privileged_role"] }
        Returns: boolean
      }
      invalidate_spec_measurement: {
        Args: { p_measurement_id: string; p_reason: string }
        Returns: {
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
      link_task_requirement: {
        Args: { p_clause_key: string; p_task_id: string }
        Returns: boolean
      }
      lock_proposal_for_command: {
        Args: { p_proposal_id: string }
        Returns: {
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
      pgp_armor_headers: {
        Args: { "": string }
        Returns: Record<string, unknown>[]
      }
      promote_proposal: {
        Args: {
          p_owner_id?: string
          p_proposal_id: string
          p_season_id: string
        }
        Returns: {
          created: boolean
          task: Database["public"]["Tables"]["tasks"]["Row"]
        }[]
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
      record_spec_measurement: {
        Args: {
          p_measured_at?: string
          p_note?: string
          p_request_id: string
          p_season_id: string
          p_source?: string
          p_spec_id: string
          p_value_bool?: boolean
          p_value_numeric?: number
        }
        Returns: {
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
      reorder_departments: {
        Args: { p_ordered_keys: string[] }
        Returns: undefined
      }
      restore_task: {
        Args: { p_task_id: string }
        Returns: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
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
        Args: { p_action: string; p_proposal_id: string }
        Returns: {
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
      set_current_season: { Args: { p_season_id: string }; Returns: undefined }
      set_proposal_requirements: {
        Args: { p_clause_keys: string[]; p_proposal_id: string }
        Returns: undefined
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
      privileged_role: "developer" | "treasurer" | "president" | "vicepresident"
      proposal_outcome: "approved" | "rejected"
      task_priority: "normal" | "urgent"
      task_state: "todo" | "wip" | "blocked" | "done" | "cancelled"
      topic_state: "open" | "agenda" | "decided" | "parked"
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
      privileged_role: ["developer", "treasurer", "president", "vicepresident"],
      proposal_outcome: ["approved", "rejected"],
      task_priority: ["normal", "urgent"],
      task_state: ["todo", "wip", "blocked", "done", "cancelled"],
      topic_state: ["open", "agenda", "decided", "parked"],
    },
  },
} as const

