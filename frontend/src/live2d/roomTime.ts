export type RoomPhase='morning'|'day'|'evening'|'night';
export function roomPhase(hour:number):RoomPhase {
 return hour>=5&&hour<10?'morning':hour>=10&&hour<17?'day':hour>=17&&hour<20?'evening':'night';
}
export const roomImages:Record<RoomPhase,string>={morning:'/stage/room-morning.webp',day:'/stage/stage-room.jpg',evening:'/stage/room-evening.webp',night:'/stage/room-night.webp'};
