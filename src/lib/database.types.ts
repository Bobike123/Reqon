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
          section: string
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
          section: string
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
          section?: string
          specs?: Json
          subteam_key?: string | null
        }
        Relationships: [
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
      specs: {
        Row: {
          clause_key: string | null
          comparator: string
          condition: string | null
          id: string
          measured: number | null
          measured_at: string | null
          measured_by: string | null
          parameter: string
          season_id: string
          sort_order: number
          target: number | null
          target_text: string | null
          unit: string | null
        }
        Insert: {
          clause_key?: string | null
          comparator: string
          condition?: string | null
          id?: string
          measured?: number | null
          measured_at?: string | null
          measured_by?: string | null
          parameter: string
          season_id: string
          sort_order?: number
          target?: number | null
          target_text?: string | null
          unit?: string | null
        }
        Update: {
          clause_key?: string | null
          comparator?: string
          condition?: string | null
          id?: string
          measured?: number | null
          measured_at?: string | null
          measured_by?: string | null
          parameter?: string
          season_id?: string
          sort_order?: number
          target?: number | null
          target_text?: string | null
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
          book_section: string
          description: string | null
          is_parked: boolean
          key: string
          lead_id: string | null
          name: string
          sort_order: number
        }
        Insert: {
          book_section: string
          description?: string | null
          is_parked?: boolean
          key: string
          lead_id?: string | null
          name: string
          sort_order?: number
        }
        Update: {
          book_section?: string
          description?: string | null
          is_parked?: boolean
          key?: string
          lead_id?: string | null
          name?: string
          sort_order?: number
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
      tasks: {
        Row: {
          created_at: string
          created_by: string | null
          detail: string | null
          due_date: string | null
          id: string
          owner_id: string | null
          season_id: string
          source_proposal: string | null
          starred: boolean
          state: Database["public"]["Enums"]["task_state"]
          subteam_key: string | null
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          detail?: string | null
          due_date?: string | null
          id?: string
          owner_id?: string | null
          season_id: string
          source_proposal?: string | null
          starred?: boolean
          state?: Database["public"]["Enums"]["task_state"]
          subteam_key?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          detail?: string | null
          due_date?: string | null
          id?: string
          owner_id?: string | null
          season_id?: string
          source_proposal?: string | null
          starred?: boolean
          state?: Database["public"]["Enums"]["task_state"]
          subteam_key?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
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
            foreignKeyName: "tasks_source_proposal_fkey"
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
      task_proposals: {
        Row: {
          context: string | null
          decided_at: string | null
          decision: string | null
          id: string
          meeting_id: string | null
          owner_id: string | null
          raised_by: string | null
          raised_on: string
          season_id: string
          starred: boolean
          state: Database["public"]["Enums"]["topic_state"]
          title: string
          updated_at: string
        }
        Insert: {
          context?: string | null
          decided_at?: string | null
          decision?: string | null
          id?: string
          meeting_id?: string | null
          owner_id?: string | null
          raised_by?: string | null
          raised_on?: string
          season_id: string
          starred?: boolean
          state?: Database["public"]["Enums"]["topic_state"]
          title: string
          updated_at?: string
        }
        Update: {
          context?: string | null
          decided_at?: string | null
          decision?: string | null
          id?: string
          meeting_id?: string | null
          owner_id?: string | null
          raised_by?: string | null
          raised_on?: string
          season_id?: string
          starred?: boolean
          state?: Database["public"]["Enums"]["topic_state"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_proposals_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_proposals_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_proposals_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_proposals_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_proposals_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_current_season"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_proposals_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "v_subteam_progress"
            referencedColumns: ["season_id"]
          },
        ]
      }
    }
    Views: {
      spec_verdicts: {
        Row: {
          clause_key: string | null
          comparator: string | null
          condition: string | null
          id: string | null
          measured: number | null
          measured_at: string | null
          measured_by: string | null
          parameter: string | null
          season_id: string | null
          sort_order: number | null
          target: number | null
          target_text: string | null
          unit: string | null
          verdict: string | null
        }
        Insert: {
          clause_key?: string | null
          comparator?: string | null
          condition?: string | null
          id?: string | null
          measured?: number | null
          measured_at?: string | null
          measured_by?: string | null
          parameter?: string | null
          season_id?: string | null
          sort_order?: number | null
          target?: number | null
          target_text?: string | null
          unit?: string | null
          verdict?: never
        }
        Update: {
          clause_key?: string | null
          comparator?: string | null
          condition?: string | null
          id?: string | null
          measured?: number | null
          measured_at?: string | null
          measured_by?: string | null
          parameter?: string | null
          season_id?: string | null
          sort_order?: number | null
          target?: number | null
          target_text?: string | null
          unit?: string | null
          verdict?: never
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
      v_attention: {
        Row: {
          clause_key: string | null
          kind: string | null
          owner_id: string | null
          reason: string | null
          ref: string | null
          season_id: string | null
          starred: boolean | null
          title: string | null
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
      can_delete_records: { Args: never; Returns: boolean }
      can_manage_finances: { Args: never; Returns: boolean }
      can_manage_roles: { Args: never; Returns: boolean }
      can_view_finances: { Args: never; Returns: boolean }
      has_role: {
        Args: { wanted: Database["public"]["Enums"]["privileged_role"] }
        Returns: boolean
      }
      is_admin: { Args: never; Returns: boolean }
      is_member: { Args: never; Returns: boolean }
      set_current_season: { Args: { p_season_id: string }; Returns: undefined }
    }
    Enums: {
      clause_state: "open" | "wip" | "compliant" | "verified" | "blocked" | "na"
      finance_kind: "income" | "expense"
      member_state: "active" | "alumni"
      privileged_role: "developer" | "treasurer" | "president" | "vicepresident"
      task_state: "urgent" | "todo" | "wip" | "blocked" | "done" | "cancelled"
      topic_state: "open" | "agenda" | "decided" | "parked"
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
      task_state: ["urgent", "todo", "wip", "blocked", "done", "cancelled"],
      topic_state: ["open", "agenda", "decided", "parked"],
    },
  },
} as const

