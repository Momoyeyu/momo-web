export function autoPhone(open:boolean,suppressed:boolean,busy:boolean,focused:boolean){return open||(!suppressed&&busy&&!focused);}
