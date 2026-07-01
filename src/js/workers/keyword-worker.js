const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'arent', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'cant', 'cannot',
  'could', 'couldnt', 'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during', 'each', 'few',
  'for', 'from', 'further', 'had', 'hadnt', 'has', 'hasnt', 'have', 'havent', 'having', 'he', 'hed', 'hell',
  'hes', 'her', 'here', 'heres', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'hows', 'i', 'id', 'ill',
  'im', 'ive', 'if', 'in', 'into', 'is', 'isnt', 'it', 'its', 'itself', 'lets', 'me', 'more', 'most', 'mustnt',
  'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours',
  'ourselves', 'out', 'over', 'own', 'same', 'shant', 'she', 'shed', 'shell', 'shes', 'should', 'shouldnt', 'so',
  'some', 'such', 'than', 'that', 'thats', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'theres', 'these', 'they', 'theyd', 'theyll', 'theyre', 'theyve', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', 'wasnt', 'we', 'wed', 'well', 'were', 'weve', 'werent', 'what', 'whats',
  'when', 'whens', 'where', 'wheres', 'which', 'while', 'who', 'whos', 'whom', 'why', 'whys', 'with', 'wont',
  'would', 'wouldnt', 'you', 'youd', 'youll', 'youre', 'youve', 'your', 'yours', 'yourself', 'yourselves'
]);

// Set a reasonable threshold: 0.15 represents a 15% vector match
const MIN_SIMILARITY_THRESHOLD = 0.15;

function getTopKeywordFrequencies(title, description, topN = 5) {
  const combinedText = `${title} ${description}`.toLowerCase();
  const words = combinedText.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "").split(/\s+/);
  
  const frequencyMap = {};
  words.forEach(word => {
    if (word.length > 2 && !STOP_WORDS.has(word)) {
      frequencyMap[word] = (frequencyMap[word] || 0) + 1;
    }
  });
  
  const sortedEntries = Object.entries(frequencyMap)
    .sort((a, b) => b - a)
    .slice(0, topN);

  const topFreqMap = {};
  let sumOfSquares = 0;

  sortedEntries.forEach(([word, freq]) => {
    topFreqMap[word] = freq;
    sumOfSquares += freq * freq;
  });

  return {
    map: topFreqMap,
    magnitude: Math.sqrt(sumOfSquares)
  };
}

self.onmessage = function(e) {
  const { sourceDoc, comparisonDocs, topN } = e.data;
  
  const source = getTopKeywordFrequencies(sourceDoc.title, sourceDoc.description, topN);
  
  // Use reduce to filter and map in a single pass for optimal performance
  const results = comparisonDocs.reduce((filteredResults, doc) => {
    const comp = getTopKeywordFrequencies(doc.title, doc.description, topN);
    
    let dotProduct = 0;
    const matchedWords = [];

    Object.keys(comp.map).forEach(word => {
      if (source.map[word]) {
        dotProduct += source.map[word] * comp.map[word];
        matchedWords.push(word);
      }
    });

    let similarityScore = 0;
    if (source.magnitude > 0 && comp.magnitude > 0) {
      similarityScore = dotProduct / (source.magnitude * comp.magnitude);
    }

    // ONLY keep the document if it hits or exceeds our minimum threshold
    if (similarityScore >= MIN_SIMILARITY_THRESHOLD) {
      filteredResults.push({
        id: doc.id,
        title: doc.title,
        score: parseFloat(similarityScore.toFixed(4)),
        matchedKeywords: matchedWords,
        keywords: Object.keys(comp.map)
      });
    }

    return filteredResults;
  }, []);

  // Sort remaining relevant documents by score descending
  results.sort((a, b) => b.score - a.score);

  self.postMessage({
    sourceKeywords: Object.keys(source.map),
    rankedDocuments: results
  });
};
