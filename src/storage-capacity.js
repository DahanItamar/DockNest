// Filesystem usage includes all files, regardless of which application wrote them.
export function filesystemCapacity({ blockSize, blocks, free, available }) {
 const values=[blockSize,blocks,free,available].map(Number);
 const [unit,totalBlocks,freeBlocks,availableBlocks]=values;
 if(!values.every(Number.isSafeInteger)||unit<=0||totalBlocks<=0||freeBlocks<0||freeBlocks>totalBlocks||availableBlocks<0||availableBlocks>freeBlocks)throw new Error('Storage did not report valid filesystem capacity');
 const result={total:unit*totalBlocks,used:unit*(totalBlocks-freeBlocks),available:unit*availableBlocks};
 if(!Object.values(result).every(Number.isSafeInteger))throw new Error('Storage capacity exceeds the supported byte range');
 return result;
}
