import re
import nltk
from nltk.tokenize import word_tokenize
from nltk.stem import WordNetLemmatizer
from nltk.corpus import stopwords

nltk.download('punkt',              quiet=True)
nltk.download('punkt_tab',         quiet=True)
nltk.download('stopwords',         quiet=True)
nltk.download('wordnet',           quiet=True)
nltk.download('averaged_perceptron_tagger', quiet=True)

_lemmatizer = WordNetLemmatizer()
_stop_words = set(stopwords.words('english'))

# Must match the KEEP_WORDS from training exactly
KEEP_WORDS = {
    'no', 'not', 'urgent', 'please', 'confirm', 'approve', 'pending',
    'asap', 'deadline', 'immediately', 'overdue', 'reminder', 'meeting',
    'schedule', 'birthday', 'happy', 'congratulation', 'newsletter',
    'follow', 'up', 'action', 'required', 'review', 'approve', 'request'
}
_stop_words -= KEEP_WORDS

def preprocess(subject: str, body: str) -> str:
    def clean(text: str) -> str:
        if not isinstance(text, str):
            return ''
        text = text.lower()
        text = re.sub(r'\S+@\S+', '', text)
        text = re.sub(r'http\S+|www\.\S+', '', text)
        text = re.sub(r'<[^>]+>', '', text)
        text = re.sub(r'[^a-z0-9\s]', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text

    subject_clean = clean(subject).replace('no subject', '').replace('no_subject', '')
    body_clean    = clean(body)

    # Subject weighted 3x — must match training
    combined = (subject_clean + ' ') * 3 + body_clean
    combined = combined.strip()

    tokens = word_tokenize(combined)
    tokens = [
        _lemmatizer.lemmatize(t)
        for t in tokens
        if t.isalpha() and t not in _stop_words and len(t) > 2
    ]
    return ' '.join(tokens)