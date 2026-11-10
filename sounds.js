// Generated from public/openapi.yaml - the authoritative sound list.
// Regenerate with: node ../tools/gen-mcp-sounds.js (or re-run the project script).

export const SOUND_GROUPS = {
  'Money & sales': ['cash_register', 'ka_ching', 'coin', 'coin_win', 'coin_drop', 'coin_received', 'coin_clatter', 'coin_collision', 'casino_bling', 'bonus_reached'],
  'Success & progress': ['level_up_1', 'level_up_2', 'level_up_3', 'level_complete', 'uplifting_bells', 'fireworks', 'bottles_clink'],
  'Failure & warning': ['buzzer', 'error_1', 'error_2', 'error_3', 'game_over'],
  'Neutral / informational': ['notification_1', 'notification_2', 'notification_3', 'notification_4', 'notification_5', 'bell_ding', 'news_ting', 'church_bell'],
  'Attention-grabbing': ['doorbell_1', 'doorbell_2', 'doorbell_3', 'doorbell_4', 'car_horn_1', 'car_horn_2', 'dog_bark'],
  'Playful': ['cat_meow_1', 'cat_meow_2', 'rubber_duck'],
};

export const SOUNDS = ['default', ...Object.values(SOUND_GROUPS).flat()];

export function groupOf(id) {
  for (const [group, ids] of Object.entries(SOUND_GROUPS)) if (ids.includes(id)) return group;
  return id === 'default' ? 'Default' : null;
}
