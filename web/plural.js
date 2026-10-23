// One place for "count + noun" strings: 1 backup, 2 backups, 0 backups. Pass the plural form for irregular nouns.
export const plural=(count,one,many=one+'s')=>count===1?one:many;
export const count=(value,one,many)=>value+' '+plural(value,one,many);
