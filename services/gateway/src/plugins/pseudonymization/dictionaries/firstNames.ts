/**
 * Common given names — a CONFIDENCE SIGNAL, never a detector.
 *
 * Nothing in this list masks anything on its own. It is read only by `scoreMatch`
 * (detectors/confidence.ts), where a token of a candidate span appearing here adds +0.15
 * to that candidate's confidence, and by the ALL-CAPS person lift, where it is one of the
 * three accepted forms of person evidence. A name absent from the list is not evidence
 * AGAINST anything; it simply contributes nothing.
 *
 * ## Why this list carries weight
 *
 * The capitalised-run heuristic scores 0.5, exactly the default threshold, so a run masks
 * unless something argues against it — a machinery neighbour, an ALL-CAPS token, a run of
 * ordinary English words. A given name is +0.15 of headroom above that bar, which is what
 * keeps a real name masked where one of those arguments also applies: `Dear JOHN SMITH,`
 * clears the bar at 0.65 only because JOHN is here to offset the ALL-CAPS penalty.
 *
 * Every name added is therefore recall gained and no precision lost — the list can only
 * raise the score of a candidate some detector already produced, never create one.
 *
 * ## What belongs here
 *
 * Ordinary given names in wide use, nothing deployment-specific, personal or
 * operator-supplied — which is also why the list may live in a public repository. Words
 * that are far more often ordinary English than a name ("Will", "May", "June", "Art",
 * "Hope") are deliberately LEFT OUT: they would lift any capitalised pair containing them
 * to the masking threshold, which is how "Mark Down" becomes a person.
 *
 * Lower-cased at module load and looked up case-insensitively, so `MARIA`, `Maria` and
 * `maria` are the same entry.
 */
const NAMES = [
  // English
  'james', 'john', 'robert', 'michael', 'william', 'david', 'richard', 'joseph',
  'thomas', 'charles', 'christopher', 'daniel', 'matthew', 'anthony', 'mark',
  'donald', 'steven', 'paul', 'andrew', 'joshua', 'kenneth', 'kevin', 'brian',
  'george', 'timothy', 'ronald', 'edward', 'jason', 'jeffrey', 'ryan', 'jacob',
  'gary', 'nicholas', 'eric', 'jonathan', 'stephen', 'larry', 'justin', 'scott',
  'brandon', 'benjamin', 'samuel', 'gregory', 'alexander', 'patrick', 'jack',
  'dennis', 'jerry', 'tyler', 'aaron', 'henry', 'douglas', 'peter', 'adam',
  'nathan', 'zachary', 'walter', 'kyle', 'harold', 'carl', 'arthur', 'gerald',
  'roger', 'keith', 'jeremy', 'lawrence', 'terry', 'sean', 'albert', 'joe',
  'mary', 'patricia', 'jennifer', 'linda', 'elizabeth', 'barbara', 'susan',
  'jessica', 'sarah', 'karen', 'nancy', 'lisa', 'margaret', 'betty', 'sandra',
  'ashley', 'dorothy', 'kimberly', 'emily', 'donna', 'michelle', 'carol',
  'amanda', 'melissa', 'deborah', 'stephanie', 'rebecca', 'laura', 'sharon',
  'cynthia', 'kathleen', 'amy', 'shirley', 'angela', 'helen', 'anna', 'brenda',
  'pamela', 'nicole', 'ruth', 'katherine', 'samantha', 'christine', 'catherine',
  'virginia', 'rachel', 'janet', 'emma', 'caroline', 'olivia', 'sophia', 'grace',
  'hannah', 'alice', 'julia', 'victoria', 'lucy', 'chloe', 'eleanor', 'abigail',
  'charlotte', 'amelia', 'harry', 'oliver', 'jake', 'lewis', 'callum', 'connor',
  'jane', 'joan', 'joanne', 'joanna', 'janice', 'jean', 'jill',
  'judith', 'judy', 'julie', 'joyce', 'diane', 'debra', 'doris', 'gloria',
  'evelyn', 'jacqueline', 'marilyn', 'theresa', 'teresa', 'beverly', 'denise',
  'tammy', 'irene', 'lori', 'rachael', 'marie', 'kelly', 'christina',
  'ann', 'anne', 'annie', 'peggy', 'crystal', 'gladys', 'rita', 'dawn',
  'connie', 'florence', 'tracy', 'edna', 'tiffany', 'carmen', 'rosa', 'cindy',
  'wendy', 'phyllis', 'shannon', 'sherry', 'bonnie',
  'ellen', 'lauren', 'megan', 'allison', 'danielle', 'erin', 'holly', 'brittany',
  'audrey', 'vanessa', 'kelsey', 'jenna', 'natalie', 'kayla', 'alexis', 'sydney',
  'jasmine', 'maya', 'zoe', 'ella', 'lily', 'ruby', 'isla', 'poppy', 'freya',
  'elvira', 'esther', 'edith', 'mabel', 'agnes', 'nora', 'iris', 'clara',
  'raymond', 'roy', 'russell', 'randy', 'philip', 'phillip', 'howard',
  'eugene', 'bruce', 'ralph', 'craig', 'alan', 'allen', 'shawn', 'clarence',
  'dean', 'chad', 'curtis', 'todd', 'travis', 'wesley', 'marcus',
  'derek', 'trevor', 'glenn', 'lance', 'shane', 'dustin', 'cody', 'colin',
  'ian', 'nathaniel', 'lucas', 'ethan', 'logan', 'mason', 'noah', 'liam',
  'caleb', 'evan', 'owen', 'cameron', 'hunter', 'jordan', 'blake', 'chase',
  'graham', 'malcolm', 'duncan', 'stuart', 'neil', 'barry', 'clive', 'nigel',
  'geoffrey', 'simon', 'martin', 'wayne', 'leonard',
  'norman', 'stanley', 'vernon', 'lester', 'floyd', 'earl', 'clyde', 'otis',
  // Spanish / Portuguese
  'jose', 'juan', 'carlos', 'luis', 'miguel', 'pedro', 'jorge', 'manuel',
  'francisco', 'antonio', 'rafael', 'ricardo', 'fernando', 'diego', 'alejandro',
  'javier', 'sergio', 'pablo', 'eduardo', 'raul', 'alberto', 'andres', 'ruben',
  'maria', 'ana', 'isabel', 'pilar', 'dolores', 'lucia',
  'elena', 'cristina', 'marta', 'beatriz', 'silvia', 'paula', 'sofia', 'valeria',
  'camila', 'gabriela', 'daniela', 'mariana', 'natalia', 'joao',
  'tiago', 'rui', 'goncalo', 'ines', 'catarina', 'mafalda',
  // French
  'pierre', 'jacques', 'philippe', 'olivier', 'nicolas', 'laurent',
  'thierry', 'christophe', 'stephane', 'frederic', 'julien', 'sebastien',
  'vincent', 'guillaume', 'mathieu', 'sylvie', 'nathalie', 'isabelle',
  'francoise', 'monique', 'christiane', 'sandrine', 'valerie', 'celine',
  'aurelie', 'camille', 'manon', 'juliette',
  // German / Dutch / Nordic
  'hans', 'klaus', 'wolfgang', 'jurgen', 'dieter', 'gunter', 'horst',
  'helmut', 'manfred', 'andreas', 'stefan', 'markus', 'matthias', 'sebastian',
  'lukas', 'jonas', 'felix', 'moritz', 'tobias', 'florian', 'maximilian',
  'ursula', 'ingrid', 'renate', 'monika', 'gisela', 'sabine', 'petra', 'birgit',
  'claudia', 'andrea', 'katrin', 'heike', 'silke', 'anja', 'jana',
  'lena', 'lea', 'mia', 'hanna', 'greta', 'johanna', 'annika',
  // 'jan' is deliberately absent: it collides with the month abbreviation, and
  // "Jan 2026 Report" is not a person.
  'kees', 'willem', 'joris', 'sander', 'bram', 'daan', 'sanne', 'femke',
  'lars', 'erik', 'anders', 'bjorn', 'sven', 'nils', 'ole', 'magnus', 'henrik',
  'astrid', 'karin', 'linnea', 'freja', 'sofie', 'elin',
  // Italian / Greek / Slavic
  'giuseppe', 'giovanni', 'marco', 'francesco', 'luca', 'matteo',
  'alessandro', 'stefano', 'giulia', 'chiara', 'francesca',
  'valentina', 'martina', 'alessia', 'nikolaos', 'dimitrios', 'georgios',
  'konstantinos', 'eleni', 'ivan', 'dmitri', 'sergei', 'vladimir',
  'alexei', 'nikolai', 'mikhail', 'pavel', 'andrei', 'olga',
  'svetlana', 'irina', 'tatiana', 'ekaterina', 'anastasia', 'katarzyna',
  'agnieszka', 'piotr', 'tomasz', 'krzysztof', 'jakub',
  // Arabic / Turkish / Persian / Hebrew
  'mohammed', 'muhammad', 'ahmed', 'ahmad', 'ali', 'omar', 'hassan', 'hussein',
  'khaled', 'youssef', 'ibrahim', 'mustafa', 'yasin', 'bilal', 'tarek',
  'fatima', 'aisha', 'layla', 'noor', 'zainab', 'mariam', 'huda', 'rania',
  'mehmet', 'emre', 'burak', 'cem', 'ayse', 'zeynep', 'elif',
  'reza', 'amir', 'farid', 'nasrin', 'parisa', 'avi', 'yosef',
  'rivka', 'tamar', 'noa',
  // South Asian
  'raj', 'rajesh', 'amit', 'sunil', 'anil', 'vijay', 'ravi', 'sanjay', 'arun',
  'deepak', 'rahul', 'arjun', 'karan', 'aditya', 'rohit', 'nikhil', 'priya',
  'anita', 'sunita', 'kavita', 'neha', 'pooja', 'divya', 'shreya', 'ananya',
  'meera', 'lakshmi', 'aarav', 'vivaan', 'ishaan',
  // East and South-East Asian
  'wei', 'ming', 'jun', 'hao', 'lei', 'yan', 'xiao', 'chen', 'li', 'jing',
  'mei', 'ying', 'hiroshi', 'takashi', 'kenji', 'yuki', 'haruto', 'sota',
  'akira', 'sakura', 'hana', 'aoi', 'minjun', 'jihoon', 'seojun', 'jiwoo',
  'hyunwoo', 'jisoo', 'seoyeon', 'nguyen', 'minh', 'linh', 'thao', 'anh',
  // African
  'kwame', 'kofi', 'kwesi', 'chidi', 'emeka', 'obi', 'tunde', 'olu', 'sipho',
  'thabo', 'amara', 'ngozi', 'chioma', 'adaeze', 'zola', 'naledi', 'ayanda',
];

/** Lower-cased lookup set. Exported for `scoreMatch` and the ALL-CAPS person lift. */
export const FIRST_NAMES: ReadonlySet<string> = new Set(NAMES);
